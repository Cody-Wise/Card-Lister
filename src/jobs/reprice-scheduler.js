// Scheduled repricing: for each unsold, published card, refreshes eBay-image
// sold comps, computes a fresh repricing signal (same logic as the manual
// "reprice" button), and — unlike the manual flow, which only suggests and
// requires a separate "update price" click — automatically pushes the new
// price to eBay when the drift clears a threshold.
//
// Reuses the exact same building blocks as the manual routes in app.js
// (POST /api/ebay/listings/reprice and /update-price) rather than
// reimplementing pricing logic, so this stays in sync with however that
// logic evolves.
//
// Follows the same read-snapshot -> unlocked-compute -> locked-write split as
// src/jobs/pipeline.js: all network I/O (comp lookup, the live eBay price
// push) runs OUTSIDE the state lock, so repricing many listings doesn't
// freeze the rest of the app the way holding the lock across those calls
// would.
import { getLiveCardComps } from "../services/comps.js";
import { updateEbayListingPrice } from "../services/ebay.js";
import { isRelevantComp } from "./pipeline.js";
import { resolveGraderAndGrade, extractGraderAndGradeFromTitle } from "../services/ebay-condition.js";
import {
  buildExternalCompLookupMetadata,
  buildOfferExternalCompLookupMetadata,
  buildEbayPricingSummary,
  buildManualRepricingSignal,
  pickImageUrl,
  rememberOfferEbayTitle,
  withTimeout,
  normalizeSalesCurrencyValue,
} from "../app.js";
import { createAuditEvent, nowIso, withState, withStateReadOnly } from "../lib/store.js";

function repriceThreshold(minDelta) {
  if (Number.isFinite(minDelta)) return minDelta;
  const parsed = Number(process.env.REPRICE_MIN_DELTA);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0.5;
}

// Hard safety rails on the fully-automated scheduler specifically — unlike
// the manual "reprice" button (a human reviews the suggestion before
// clicking "update price"), this job pushes a new price to eBay with no
// human in the loop, so a single bad comp match (see the card_0123/card_0127
// pricing bugs earlier this session) can't be allowed to swing a listing's
// price arbitrarily far in one run. Bounds are relative to the CURRENT
// listed price, not the comp-derived target.
function repriceMinFactor() {
  const parsed = Number(process.env.REPRICE_MIN_FACTOR);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : 0.8;
}

function repriceMaxFactor() {
  const parsed = Number(process.env.REPRICE_MAX_FACTOR);
  return Number.isFinite(parsed) && parsed > 1 ? parsed : 1.2;
}

// Clamps a comp-derived target price to [currentPrice * minFactor, currentPrice
// * maxFactor], rounded to cents. Returns the clamped price plus whether
// clamping actually changed anything, so callers can log/audit it.
export function clampRepriceTarget(rawTargetPrice, currentPrice) {
  const minFactor = repriceMinFactor();
  const maxFactor = repriceMaxFactor();
  const min = currentPrice * minFactor;
  const max = currentPrice * maxFactor;
  const clamped = Math.min(max, Math.max(min, rawTargetPrice));
  const rounded = Math.round(clamped * 100) / 100;
  return { price: rounded, clamped: rounded !== Math.round(rawTargetPrice * 100) / 100, min, max };
}

function lookupTimeoutMs() {
  const parsed = Number(process.env.REPRICE_LOOKUP_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20000;
}

// A comp is only usable evidence for the auto-repricer when it's confirmed
// to be the SAME grading state as the target card — comparing a raw card's
// price against a PSA-10 slab's (or vice versa) isn't a real match no matter
// how well player/year/set/card-number line up. Confirmed live: this exact
// gap let a raw-vs-graded (or wrong-grade) comp anchor a wildly wrong
// scheduled reprice target on a PSA-10 Kyler Murray.
export function matchesTargetGrade(comp, gradeTarget) {
  const { grader: compGrader, grade: compGrade } = extractGraderAndGradeFromTitle(comp?.title || "");
  const compIsGraded = Boolean(compGrader && compGrade);
  if (gradeTarget.isGraded !== compIsGraded) return false;
  if (!gradeTarget.isGraded) return true; // both raw — nothing further to compare
  if (gradeTarget.grader && compGrader && gradeTarget.grader !== compGrader) return false;
  if (gradeTarget.grade && compGrade && gradeTarget.grade !== compGrade) return false;
  return true;
}

// Filters comps down to ones that pass BOTH the same core-identity relevance
// check the main pricing pipeline already relies on (isRelevantComp — player/
// year/card-number/set) AND the grade-match check above. This is the
// "exact match" bar the scheduler requires before it's allowed to touch a
// live price with no human review.
export function filterExactMatchComps(comps, lookupMetadata, gradeTarget) {
  return (Array.isArray(comps) ? comps : []).filter(
    (comp) => isRelevantComp(comp, lookupMetadata) && matchesTargetGrade(comp, gradeTarget),
  );
}

// Absolute per-card min/max always wins over the relative +/-20% band, when
// set. Pulled out as a pure function so the override behavior is directly
// testable without mocking the network calls the rest of computeReprice makes.
export function applyAbsoluteBounds(price, minPrice, maxPrice) {
  const min = Number.isFinite(minPrice) && minPrice > 0 ? minPrice : -Infinity;
  const max = Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : Infinity;
  return Math.min(max, Math.max(min, price));
}

// A card is a repricing candidate when it's live on eBay (published) and not
// yet sold.
function isRepriceable(card) {
  return (
    card &&
    card.status !== "sold" &&
    (card.publishState === "published" || card.status === "listed") &&
    Boolean(card.listingId || card.listingUrl)
  );
}

async function runWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(workers);
}

// Runs comp lookup + repricing math + (if warranted) the live eBay price push
// for one card/offer pair. Operates on detached clones — does NOT hold the
// state lock. Returns a plain patch for the write phase to apply.
async function computeReprice({ card: cardSnapshot, offer: offerSnapshot, threshold }) {
  const card = cardSnapshot ? { ...cardSnapshot } : null;
  const offer = offerSnapshot ? { ...offerSnapshot } : null;

  const currentPrice = normalizeSalesCurrencyValue(offer?.price ?? card?.recommendedPrice);
  if (!(Number.isFinite(currentPrice) && currentPrice > 0)) {
    return { skipped: "no-current-price" };
  }

  const imageUrl = pickImageUrl(
    offer?.imageUrl || "",
    card?.frontImageUrl || "",
    card?.backImageUrl || "",
  );
  const lookupMetadata = card
    ? buildExternalCompLookupMetadata(card, offer?.ebayTitle || "", imageUrl)
    : buildOfferExternalCompLookupMetadata(offer, card?.ebayTitle || "", imageUrl);

  const lookupResult = await withTimeout(
    getLiveCardComps(lookupMetadata, null, null, null, card?.externalSoldComps || [], imageUrl),
    lookupTimeoutMs(),
    "eBay image search sold comp lookup",
  );

  const isGraded = card?.candidateCondition === "graded" || Boolean(card?.gradedFlag);
  const gradeTarget = isGraded
    ? { isGraded: true, ...resolveGraderAndGrade(card || {}) }
    : { isGraded: false, grader: null, grade: null };
  const filteredSold = filterExactMatchComps(lookupResult.sold, lookupMetadata, gradeTarget);
  const filteredActive = filterExactMatchComps(lookupResult.active, lookupMetadata, gradeTarget);

  const summaryRecord = card || offer || {};
  const pricingSummary = buildEbayPricingSummary(summaryRecord, filteredSold, filteredActive);

  if (offer) {
    if (imageUrl && !offer.imageUrl) offer.imageUrl = imageUrl;
    rememberOfferEbayTitle(offer, lookupMetadata.titleHint);
    offer.externalCompLookupAttemptedAt = nowIso();
    offer.externalCompSource = "ebay_image_search";
    offer.externalPricingSummary = pricingSummary;
    offer.externalCompUpdatedAt = nowIso();
    offer.updatedAt = nowIso();
    delete offer.apifyError;
  }
  if (card) {
    card.externalCompLookupAttemptedAt = nowIso();
    card.externalSoldComps = filteredSold.slice(0, 50);
    card.externalCompSource = "ebay_image_search";
    card.externalPricingSummary = pricingSummary;
    card.externalCompUpdatedAt = nowIso();
    card.updatedAt = nowIso();
    delete card.apifyError;
  }

  // Exact-match gate: at least one relevance+grade-filtered sold comp, and —
  // when the card has a specific parallel — that parallel must have been
  // confirmed (exact/similar), not just passed through unfiltered. No human
  // reviews this job's price pushes, so an unconfirmed match is a skip, not
  // a best-effort guess.
  const parallelConfirmed =
    !lookupMetadata.parallel ||
    pricingSummary?.soldParallelFilterMode === "exact_parallel" ||
    pricingSummary?.soldParallelFilterMode === "similar_parallel";
  const isExactMatch = filteredSold.length > 0 && parallelConfirmed;

  // Anchor the relative +/-20% clamp to a stable baseline captured once,
  // rather than the current (possibly already-drifted) price — otherwise
  // repeated cycles compound instead of holding a line. Confirmed live: a
  // PSA-10 card ratcheted up 20% every single 6-hour run for a week straight
  // toward a wrong target, since each run's clamp used the prior run's
  // already-inflated price as its new base.
  if (card && !(Number.isFinite(card.repriceBaselinePrice) && card.repriceBaselinePrice > 0)) {
    card.repriceBaselinePrice = currentPrice;
  }
  const baselinePrice = card?.repriceBaselinePrice || currentPrice;

  const repricing = buildManualRepricingSignal(card, offer, currentPrice);

  if (!isExactMatch) {
    return {
      card,
      offer,
      repriced: false,
      skippedReason: "no-exact-match",
      repricing,
    };
  }

  const rawTargetPrice = normalizeSalesCurrencyValue(repricing.targetPrice);
  const hasRawTarget = Number.isFinite(rawTargetPrice) && rawTargetPrice > 0;
  const relativeClamp = hasRawTarget ? clampRepriceTarget(rawTargetPrice, baselinePrice) : null;
  const newPrice = relativeClamp
    ? normalizeSalesCurrencyValue(
        applyAbsoluteBounds(relativeClamp.price, card?.repriceMinPrice, card?.repriceMaxPrice),
      )
    : null;
  const shouldReprice =
    (repricing.status === "overpriced" || repricing.status === "underpriced") &&
    Number.isFinite(newPrice) &&
    newPrice > 0 &&
    Math.abs(newPrice - currentPrice) >= threshold;

  if (!shouldReprice) {
    return { card, offer, repriced: false, repricing };
  }

  // The live eBay call — deliberately still outside any state lock.
  await updateEbayListingPrice({
    offerId: offer?.ebayOfferId || null,
    sku: offer?.sku || card?.sku || null,
    listingId: card?.listingId || offer?.listingId || null,
    price: newPrice,
  });

  if (offer) {
    offer.price = newPrice;
    offer.updatedAt = nowIso();
  }
  if (card) {
    card.recommendedPrice = newPrice;
    card.updatedAt = nowIso();
  }

  return {
    card,
    offer,
    repriced: true,
    oldPrice: currentPrice,
    newPrice,
    rawTargetPrice,
    baselinePrice,
    clampedToBounds: relativeClamp?.clamped || newPrice !== relativeClamp?.price,
    repricing,
  };
}

// Merges a computed result back onto the live card/offer. No network I/O;
// holds the lock only long enough to write.
async function writeReprice({ cardId, offerId, result }) {
  return withState(async (state) => {
    if (result.card) {
      const liveCard = (state.cardItems || []).find((item) => item.id === cardId);
      if (liveCard) Object.assign(liveCard, result.card);
    }
    if (result.offer) {
      const liveOffer = (state.offers || []).find((item) => item.id === offerId);
      if (liveOffer) Object.assign(liveOffer, result.offer);
    }
    if (result.repriced) {
      createAuditEvent(state, "cardItem", cardId, "scheduled_reprice", {
        offerId,
        oldPrice: result.oldPrice,
        newPrice: result.newPrice,
        rawTargetPrice: result.rawTargetPrice,
        baselinePrice: result.baselinePrice,
        clampedToBounds: result.clampedToBounds,
        repricing: result.repricing,
      });
    } else if (result.skippedReason) {
      createAuditEvent(state, "cardItem", cardId, "scheduled_reprice_skipped", {
        offerId,
        reason: result.skippedReason,
        repricing: result.repricing,
      });
    }
    return { cardId, offerId, repriced: Boolean(result.repriced) };
  });
}

// Evaluates every unsold, published card and applies a price update wherever
// the eBay-comp-derived target has drifted from the current price by at least
// the threshold. Per-card failures are isolated — one bad lookup doesn't stop
// the rest of the run.
export async function repriceUnsoldListings({ minDelta, concurrency = 2 } = {}) {
  const threshold = repriceThreshold(minDelta);

  const candidates = await withStateReadOnly(async (state) => {
    const offerByCardId = new Map();
    for (const offer of state.offers || []) {
      if (offer?.cardItemId) offerByCardId.set(offer.cardItemId, offer);
    }
    return (state.cardItems || [])
      .filter(isRepriceable)
      .map((card) => {
        const offer = offerByCardId.get(card.id) || null;
        return {
          cardId: card.id,
          offerId: offer?.id || null,
          card: { ...card },
          offer: offer ? { ...offer } : null,
        };
      });
  });

  const results = [];
  await runWithConcurrency(candidates, Math.max(1, Math.min(4, concurrency)), async ({ cardId, offerId, card, offer }) => {
    try {
      const computed = await computeReprice({ card, offer, threshold });
      if (computed.skipped) return;
      const outcome = await writeReprice({ cardId, offerId, result: computed });
      results.push(outcome);
    } catch (error) {
      results.push({ cardId, offerId, repriced: false, error: error.message });
    }
  });

  return {
    evaluated: candidates.length,
    repriced: results.filter((r) => r.repriced).length,
    failed: results.filter((r) => r.error).length,
    results,
  };
}
