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

function lookupTimeoutMs() {
  const parsed = Number(process.env.REPRICE_LOOKUP_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20000;
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

  const summaryRecord = card || offer || {};
  const pricingSummary = buildEbayPricingSummary(summaryRecord, lookupResult.sold, lookupResult.active);

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
    card.externalSoldComps = Array.isArray(lookupResult.sold) ? lookupResult.sold.slice(0, 50) : [];
    card.externalCompSource = "ebay_image_search";
    card.externalPricingSummary = pricingSummary;
    card.externalCompUpdatedAt = nowIso();
    card.updatedAt = nowIso();
    delete card.apifyError;
  }

  const repricing = buildManualRepricingSignal(card, offer, currentPrice);
  const newPrice = normalizeSalesCurrencyValue(repricing.targetPrice);
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

  return { card, offer, repriced: true, oldPrice: currentPrice, newPrice, repricing };
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
