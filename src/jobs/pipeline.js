import { extractCardMetadata } from "../services/ocr.js";
import { matchCardIdentity } from "../services/matching.js";
import { getLiveCardComps, searchSoldListings, hasSoldCompsProvider } from "../services/comps.js";
import { applyManualPriceAnchor } from "../services/active-listing-pricing.js";
import { buildApifyLookupKey } from "../services/apify.js";
import { calculatePrice } from "../services/pricing.js";
import { resolveGraderAndGrade, extractGraderAndGradeFromTitle } from "../services/ebay-condition.js";
import { parallelMatchesTitle, isPlausibleSerial } from "../lib/card-query.js";
import { resolveManualPriceFromFileNames } from "../lib/filename-price.js";
import { createAuditEvent, createId, nowIso, withState, withStateReadOnly } from "../lib/store.js";

// Local copy of app.js's withTimeout — not imported from there, since app.js
// itself imports from this file (inferMetadataFromTitle and others), and
// pipeline.js -> app.js -> pipeline.js would be circular.
//
// computeCardResult makes THREE separate unbounded external calls
// (extractCardMetadata, searchApifySoldListings, getLiveCardComps) and only
// the first one had a timeout as of the initial fix — confirmed live
// 2026-07-24 that a reprocess attempt still hung for 12+ minutes even after
// that fix, because the comp-lookup calls after OCR had no bound at all. All
// three now go through this same backstop, each with its own label/default
// so the eventual error is specific about which step actually hung.
async function withPipelineStepTimeout(promise, { label, timeoutMs, envVar, defaultMs }) {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : Math.max(1000, Number.parseInt(process.env[envVar], 10) || defaultMs);
  let timeoutId = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function dedupeComps(comps) {
  const seen = new Set();
  const unique = [];
  for (const comp of comps) {
    const key =
      comp.listingId ||
      comp.url ||
      `${comp.title || "comp"}:${comp.totalPrice ?? comp.price ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(comp);
  }
  return unique;
}

export function choosePricingStrategy(metadata) {
  const hasExactVariant = Boolean(metadata?.parallel || metadata?.variantLabel);
  const hasAutograph = Boolean(metadata?.autographFlag);
  const hasNumberedHint = Boolean(metadata?.serialNumber || metadata?.printRun);
  if ((hasExactVariant || hasAutograph) && hasNumberedHint) {
    return "sold_comps_median";
  }
  if (hasNumberedHint) {
    return "sold_comps_p25";
  }
  return "sold_comps_p25";
}

function isWeakCardNumber(value) {
  const normalized = String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .trim();
  if (!normalized) return true;
  if (/^\d{2,}$/.test(normalized)) return false;
  if (/^[A-Z]{1,2}$/.test(normalized)) return true;
  return normalized.length < 2;
}

function isWeakParallelLabel(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!normalized) return true;
  return new Set([
    "base",
    "wave",
    "silver",
    "gold",
    "green",
    "blue",
    "red",
    "purple",
    "orange",
    "pink",
    "black",
    "white",
  ]).has(normalized);
}

function isInsertStyleCardNumber(value) {
  const normalized = String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .trim();
  return /^[A-Z]{2,4}$/.test(normalized);
}

function normalizedCompTitle(value) {
  return cleanTitle(value).toLowerCase();
}

// Sports-card set names conventionally embed the release year in printed
// text (e.g. "2024 Panini Donruss Football", "2022-23 Panini Select..."),
// so a year explicitly present there is a stronger, OCR'd-product-text
// signal than a separately-detected year field pulled from a different
// pass (front vision vs. back vision vs. heuristic text scan can each
// contribute independently and disagree).
function extractYearFromSetName(setName) {
  const match = /\b(19|20)\d{2}\b/.exec(String(setName || ""));
  return match ? Number(match[0]) : null;
}

function compMentionsPlayer(comp, playerName) {
  const tokens = usefulNameTokens(playerName).map((token) => token.toLowerCase());
  if (!tokens.length) return true;
  const title = normalizedCompTitle(comp?.title || "");
  const requiredHits = Math.min(tokens.length, 2);
  let hits = 0;
  for (const token of tokens) {
    if (title.includes(token)) hits += 1;
  }
  return hits >= requiredHits;
}

function compMatchesCardNumber(comp, cardNumber) {
  if (isWeakCardNumber(cardNumber)) return true;
  const titleNumber = extractTitleCardNumber(comp?.title || "");
  if (!titleNumber) return true;
  return titleNumber === String(cardNumber || "").toUpperCase();
}

// Added after a real production card (2024 Luka Doncic Donruss Optic) had
// its autographFlag/cardNumber silently corrupted by "relevant" comps that
// were actually 2021-22 and 2018-19 cards from entirely different Donruss
// sub-brands (Elite, Optic Opti-Graphs, Rookie Dominator Signatures) —
// player-name and generic-set-token matching both trivially passed them
// (any "Luka Doncic" + "Donruss" title matches), and none of them had an
// extractable card number for compMatchesCardNumber to reject on either.
// Without a year check, nothing in isRelevantComp actually distinguished
// "this card" from "any card of this player ever printed under this brand".
function compMatchesYear(comp, year) {
  if (!year) return true;
  const titleYear = extractTitleYear(comp?.title || "");
  if (!titleYear) return true;
  return titleYear === Number(year);
}

function importantSetTokens(setName) {
  return usefulNameTokens(setName)
    .map((token) => token.toLowerCase())
    .filter(
      (token) =>
        !new Set([
          "panini",
          "topps",
          "upper",
          "deck",
          "basketball",
          "football",
          "baseball",
          "soccer",
          "trading",
          "card",
          "cards",
        ]).has(token),
    );
}

function compMatchesSet(comp, setName) {
  const tokens = importantSetTokens(setName);
  if (!tokens.length) return true;
  const title = normalizedCompTitle(comp?.title || "");
  return tokens.some((token) => title.includes(token));
}

// A comp whose title clearly names a DIFFERENT parallel than the target
// card's is not relevant evidence no matter how well everything else lines
// up — confirmed live 2026-07-13: a Blue Refractor/Teal Lazer card's comp
// list included "Green Lazer #/175", "Red Cracked Ice", and a plain
// unparalleled base comp, all scoring high because the match-scoring
// functions only ever ADD points for a parallel match and never subtract
// for a mismatch. No parallel on the card means nothing to check (a base
// card doesn't require its comps to say "base").
function compMatchesParallel(comp, parallel) {
  if (!parallel) return true;
  return parallelMatchesTitle(comp?.title || "", parallel);
}

// Maps one comp (from either the sold or active result array) onto the
// shape persisted in state.comps. `source` must be passed in by the caller
// based on which ARRAY the comp came from — not derived from a per-comp
// `kind` field, since normalizeSoldListing (apify.js), the primary sold-comp
// path whenever Apify is configured, never sets `kind` at all. The prior
// `comp.kind === "sold" ? comp.source : "browse_active"` check was false for
// essentially every real sold comp as a result, silently mislabeling it
// "browse_active" (confirmed live 2026-07-13 via card_0156's stored comps:
// sold listings duplicated into the "active listings" list under the wrong
// source, carrying a sold date and a doubly-nested rawPayload). listingId
// also used to read `comp.id`, which none of the three comp-normalizer
// shapes (apify.js, ebay-browse.js toBrowseItemSummary/toBrowseSoldItem)
// ever set — they all use `listingId` directly.
export function normalizeStoredComp(comp, source) {
  return {
    source,
    listingId: comp.listingId ?? null,
    title: comp.title,
    conditionLabel: comp.conditionLabel,
    salePrice: comp.salePrice ?? null,
    shippingPrice: comp.shippingPrice ?? null,
    totalPrice: comp.totalPrice ?? comp.price ?? null,
    soldAt: comp.soldAt ?? null,
    url: comp.url ?? null,
    matchScore: comp.matchScore ?? null,
    rawPayload: comp,
  };
}

export function isRelevantComp(comp, metadata) {
  return (
    compMentionsPlayer(comp, metadata?.playerName) &&
    compMatchesYear(comp, metadata?.year) &&
    compMatchesCardNumber(comp, metadata?.cardNumber) &&
    compMatchesSet(comp, metadata?.setName) &&
    compMatchesParallel(comp, metadata?.parallel)
  );
}

// A comp is only usable "exact match" evidence when it's confirmed to be the
// SAME grading state as the target card — comparing a raw card's price
// against a PSA-10 slab's (or vice versa) isn't a real match no matter how
// well player/year/set/card-number line up. Confirmed live: this exact gap
// let a raw-vs-graded (or wrong-grade) comp anchor a wildly wrong scheduled
// reprice target on a PSA-10 Kyler Murray (see reprice-scheduler.js). Kept
// dependency-free here (not in reprice-scheduler.js, which imports from
// app.js) so it can be reused by any caller — including best-offer-routes.js
// — without a circular import back through app.js.
export function matchesTargetGrade(comp, gradeTarget) {
  const { grader: compGrader, grade: compGrade } = extractGraderAndGradeFromTitle(comp?.title || "");
  const compIsGraded = Boolean(compGrader && compGrade);
  if (gradeTarget.isGraded !== compIsGraded) return false;
  if (!gradeTarget.isGraded) return true; // both raw — nothing further to compare
  if (gradeTarget.grader && compGrader && gradeTarget.grader !== compGrader) return false;
  if (gradeTarget.grade && compGrade && gradeTarget.grade !== compGrade) return false;
  return true;
}

// Filters comps down to ones that pass BOTH isRelevantComp (player/year/
// card-number/set) AND the grade-match check above — the "exact match" bar
// required before any comp is trusted for an unattended price decision
// (auto-reprice or a Best-Offer reasonableness verdict).
export function filterExactMatchComps(comps, lookupMetadata, gradeTarget) {
  return (Array.isArray(comps) ? comps : []).filter(
    (comp) => isRelevantComp(comp, lookupMetadata) && matchesTargetGrade(comp, gradeTarget),
  );
}

// Resolves the { isGraded, grader, grade } shape filterExactMatchComps needs
// from a card record — shared so callers don't each reimplement the
// graded-flag/resolveGraderAndGrade combination.
export function resolveGradeTarget(card = {}) {
  const isGraded = card?.candidateCondition === "graded" || Boolean(card?.gradedFlag);
  return isGraded
    ? { isGraded: true, ...resolveGraderAndGrade(card) }
    : { isGraded: false, grader: null, grade: null };
}

function buildExternalPricingSummary(pricing = {}, soldComps = [], activeListings = [], source = "ebay_image_search") {
  const compPrice = Number(pricing?.recommendedPrice ?? pricing?.soldMedian ?? pricing?.soldP25 ?? 0);
  if (!Number.isFinite(compPrice) || compPrice <= 0) return null;
  const lowPrice = Number(pricing?.soldP25 ?? compPrice);
  const highPrice = Number(pricing?.soldMedian ?? compPrice);
  return {
    source,
    compPrice,
    targetPrice: compPrice,
    lowPrice: Number.isFinite(lowPrice) && lowPrice > 0 ? lowPrice : compPrice,
    highPrice: Number.isFinite(highPrice) && highPrice > 0 ? highPrice : compPrice,
    low: Number.isFinite(lowPrice) && lowPrice > 0 ? lowPrice : compPrice,
    high: Number.isFinite(highPrice) && highPrice > 0 ? highPrice : compPrice,
    strategy: pricing?.strategy || "sold_comps_p25",
    confidence: pricing?.confidence || "low",
    reason: pricing?.reason || null,
    usedSoldCompCount: Number.isFinite(pricing?.soldCompCount) ? pricing.soldCompCount : soldComps.length,
    countRequested: soldComps.length + activeListings.length,
    soldMedian: Number.isFinite(pricing?.soldMedian) ? pricing.soldMedian : null,
    soldP25: Number.isFinite(pricing?.soldP25) ? pricing.soldP25 : null,
    updatedAt: nowIso(),
  };
}

function isPublishedOffer(offer) {
  if (!offer) return false;
  return (
    offer.status === "published" ||
    offer.status === "active" ||
    offer.status === "listed" ||
    Boolean(offer.listingUrl)
  );
}

function isCardEffectivelyPublished(cardItem, offers = []) {
  return (
    cardItem.publishState === "published" ||
    cardItem.status === "listed" ||
    Boolean(cardItem.listingUrl) ||
    offers.some(isPublishedOffer)
  );
}

function cleanTitle(value) {
  return String(value || "")
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCase(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) =>
      part
        .split("-")
        .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1).toLowerCase())
        .join("-"),
    )
    .join(" ");
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractTitleYear(title) {
  const season = /\b((?:19|20)\d{2})\s*[-/]\s*\d{2}\b/.exec(title);
  if (season) return Number(season[1]);
  const year = /\b((?:19|20)\d{2})\b/.exec(title);
  return year ? Number(year[1]) : null;
}

function extractTitleCardNumber(title) {
  const hash = /#\s*([a-z0-9-]{1,8})\b/i.exec(title);
  if (hash) return String(hash[1]).toUpperCase();
  const no = /\b(?:no\.?|number)\s*([a-z0-9-]{1,8})\b/i.exec(title);
  return no ? String(no[1]).toUpperCase() : null;
}

function extractTitleSerial(title) {
  const serial = /\b(\d{1,4})\s*\/\s*(\d{1,5})\b/.exec(title);
  // "611/75" was stored off a title: an index above the run is not a serial,
  // it is two unrelated numbers either side of a slash.
  if (!serial || !isPlausibleSerial(serial[1], serial[2])) {
    return { serialNumber: null, printRun: null };
  }
  return {
    serialNumber: `${serial[1]}/${serial[2]}`,
    printRun: Number(serial[2]),
  };
}

const parallelPatterns = [
  ["Red White and Blue Prizm", /\bred\s+white\s+(?:and\s+)?blue\s+prizm\b/i],
  ["Green Cracked Ice", /\bgreen\s+cracked\s+ice\b/i],
  ["Pink Ice Prizm", /\bpink\s+ice\s+prizm\b/i],
  ["Blue Wave Prizm", /\bblue\s+wave\s+prizm\b/i],
  ["Blue Refractor", /\bblue\s+refractor\b/i],
  ["Aqua Refractor", /\baqua\s+refractor\b/i],
  ["Silver Prizm", /\bsilver\s+prizm\b/i],
  ["Disco Prizm", /\bdisco\s+prizm\b/i],
  ["Holo", /\bholo\b/i],
  ["Refractor", /\brefractor\b/i],
  ["Cracked Ice", /\bcracked\s+ice\b/i],
  ["Xtra Points Red", /\bxtra\s+points\s+red\b/i],
  ["Winter Purple", /\bwinter\s+purple\b/i],
  ["Gold", /\bgold\b/i],
  ["Silver", /\bsilver\b/i],
  ["Blue", /\bblue\b/i],
  ["Green", /\bgreen\b/i],
  ["Red", /\bred\b/i],
  ["Purple", /\bpurple\b/i],
  ["Orange", /\borange\b/i],
  ["Pink", /\bpink\b/i],
  ["Black", /\bblack\b/i],
];

const variantPatterns = [
  ["Pure Players", /\bpure\s+players\b/i],
  ["Great X-Pectations", /\bgreat\s+x-?pectations\b/i],
  ["Instant Impact", /\binstant\s+impact\b/i],
  ["Emergent", /\bemergent\b/i],
  ["Rookie Kings", /\brookie\s+kings\b/i],
  ["NBA Debut", /\bnba\s+debut\b/i],
  ["Signed Sealed and Delivered", /\bsigned\s+sealed\s+and\s+delivered\b/i],
];

function matchTitlePattern(title, patterns) {
  const hit = patterns.find(([, pattern]) => pattern.test(title));
  return hit ? hit[0] : null;
}

const descriptorTokens = new Set([
  "rc",
  "rookie",
  "card",
  "cards",
  "auto",
  "autograph",
  "signed",
  "signature",
  "parallel",
  "prizm",
  "prism",
  "refractor",
  "silver",
  "gold",
  "blue",
  "green",
  "red",
  "purple",
  "pink",
  "orange",
  "black",
  "white",
  "cracked",
  "ice",
  "holo",
  "pure",
  "players",
  "great",
  "pectations",
  "instant",
  "impact",
  "emergent",
  "debut",
  "sealed",
  "delivered",
  "psa",
  "sgc",
  "bgs",
  "cgc",
]);

function stripTitleNoise(value, labels = []) {
  let text = cleanTitle(value)
    .replace(/\b(?:19|20)\d{2}\s*[-/]\s*\d{2}\b/g, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\b\d{1,4}\s*\/\s*\d{1,5}\b/g, " ")
    .replace(/#\s*[a-z0-9-]{1,8}\b/gi, " ")
    .replace(/\b(?:no\.?|number)\s*[a-z0-9-]{1,8}\b/gi, " ")
    .replace(/\b(?:psa|sgc|bgs|cgc)\s*\d{1,2}(?:\.\d)?\b/gi, " ")
    .replace(/[()]/g, " ");
  for (const label of labels.filter(Boolean)) {
    text = text.replace(new RegExp(`\\b${escapeRegex(label)}\\b`, "gi"), " ");
  }
  return text.replace(/\s+/g, " ").trim();
}

function titleTokens(value) {
  return cleanTitle(value).match(/[a-z0-9][a-z0-9'.-]*/gi) || [];
}

function usefulNameTokens(value) {
  return titleTokens(value).filter((token) => {
    const normalized = token.toLowerCase().replace(/[^a-z0-9]/g, "");
    return normalized && !/^\d+$/.test(normalized) && !descriptorTokens.has(normalized);
  });
}

function isAmbiguousChoiceTitle(value) {
  const title = cleanTitle(value);
  return (
    /\b(?:pick your card|you pick|choose your card|select your card|choose one|you choose)\b/i.test(
      title,
    ) ||
    /\b(?:complete|finish)\s+your\b.{0,35}\bset\b/i.test(title) ||
    /\brookies?\s*(?:&|\+|and|n)?\s*more\b/i.test(title) ||
    /\b(?:vets?|veterans?)\s*(?:&|\+|and|n)\s*(?:rookies?|stars?)\b/i.test(title)
  );
}

function inferPlayerAndSet(title, labels = []) {
  if (isAmbiguousChoiceTitle(title)) return { playerName: null, setName: null };

  const hash = /#\s*[a-z0-9-]{1,8}\b/i.exec(title);
  const yearMatch = /\b(?:19|20)\d{2}(?:\s*[-/]\s*\d{2})?\b/.exec(title);
  if (yearMatch && yearMatch.index > 0) {
    const beforeYearTokens = usefulNameTokens(stripTitleNoise(title.slice(0, yearMatch.index), labels));
    if (beforeYearTokens.length >= 2) {
      const afterYear = title.slice(yearMatch.index + yearMatch[0].length, hash?.index || title.length);
      return {
        playerName: titleCase(beforeYearTokens.slice(0, 4).join(" ")),
        setName: titleCase(stripTitleNoise(afterYear, labels)) || null,
      };
    }
  }

  if (hash) {
    const afterHash = title.slice(hash.index + hash[0].length);
    const afterTokens = usefulNameTokens(stripTitleNoise(afterHash, labels));
    if (afterTokens.length >= 2) {
      return {
        playerName: titleCase(afterTokens.slice(0, 3).join(" ")),
        setName: titleCase(stripTitleNoise(title.slice(0, hash.index), labels)) || null,
      };
    }
  }

  const beforeNumber = hash ? title.slice(0, hash.index) : title;
  const rawTokens = titleTokens(stripTitleNoise(beforeNumber, labels)).filter((token) => {
    const normalized = token.toLowerCase().replace(/[^a-z0-9]/g, "");
    return normalized && !/^\d+$/.test(normalized);
  });
  if (rawTokens.length < 2) return { playerName: null, setName: null };

  const suffixes = new Set(["jr", "sr", "ii", "iii", "iv"]);
  const nameLength = suffixes.has(rawTokens[rawTokens.length - 1].toLowerCase().replace(".", ""))
    ? Math.min(3, rawTokens.length)
    : 2;
  const playerTokens = rawTokens.slice(-nameLength);
  const setTokens = rawTokens.slice(0, -nameLength);
  return {
    playerName: titleCase(playerTokens.join(" ")),
    setName: setTokens.length ? titleCase(setTokens.join(" ")) : null,
  };
}

function inferSportFromEbayTitle(title) {
  const haystack = title.toLowerCase();
  if (/\b(nba|basketball|hoops)\b/.test(haystack)) return "basketball";
  if (/\b(nfl|football)\b/.test(haystack)) return "football";
  if (/\b(mlb|baseball|bowman)\b/.test(haystack)) return "baseball";
  if (/\b(soccer|premier league|fifa|uefa|mls)\b/.test(haystack)) return "soccer";
  if (/\b(wwe|wwf|wrestling|aew|wcw)\b/.test(haystack)) return "wrestling";
  if (/\b(ufc|mma|mixed martial)\b/.test(haystack)) return "mma";
  if (
    /\b(pokemon|pok[eé]mon|magic|mtg|yugioh|yu gi oh|lorcana|one piece|digimon|star wars|marvel|dc)\b/.test(
      haystack,
    )
  ) {
    return "trading cards";
  }
  return null;
}

export function inferMetadataFromTitle(title, { provider = "ebay_title", notesPrefix = "eBay title" } = {}) {
  const cleaned = cleanTitle(title);
  if (!cleaned || isAmbiguousChoiceTitle(cleaned)) return null;
  const parallel = matchTitlePattern(cleaned, parallelPatterns);
  const variantLabel = matchTitlePattern(cleaned, variantPatterns);
  const labels = [parallel, variantLabel];
  const { playerName, setName } = inferPlayerAndSet(cleaned, labels);
  const serial = extractTitleSerial(cleaned);
  const metadata = {
    playerName,
    year: extractTitleYear(cleaned),
    setName,
    cardNumber: extractTitleCardNumber(cleaned),
    parallel,
    sport: inferSportFromEbayTitle(cleaned),
    serialNumber: serial.serialNumber,
    printRun: serial.printRun,
    rookieFlag: /\b(?:rookie|rc)\b/i.test(cleaned),
    autographFlag: /\b(?:auto|autograph|signed|signature)\b/i.test(cleaned),
    variantLabel,
    confidence: 0.82,
    provider,
    notes: `${notesPrefix}: ${cleaned}`,
    titleHint: cleaned,
  };
  if (!metadata.playerName || !metadata.year) return null;
  return metadata;
}

function inferMetadataFromEbayComps(comps = {}) {
  const candidates = [...(comps.active || []), ...(comps.sold || [])]
    .filter((comp) => comp?.title)
    .filter((comp) => !isAmbiguousChoiceTitle(comp.title))
    .sort((a, b) => {
      const aRank = Number.isFinite(a.imageRank) ? a.imageRank : Number.POSITIVE_INFINITY;
      const bRank = Number.isFinite(b.imageRank) ? b.imageRank : Number.POSITIVE_INFINITY;
      if (aRank !== bRank) return aRank - bRank;
      return (b.matchScore || 0) - (a.matchScore || 0);
    });

  const parsedCandidates = candidates
    .map((comp) => {
      const title = cleanTitle(comp.title);
      const metadata = inferMetadataFromTitle(title, {
        provider: "ebay_image_search",
        notesPrefix: "eBay image/title inference",
      });
      if (!metadata) return null;
      return {
        comp,
        title,
        metadata,
      };
    })
    .filter(Boolean)
    .filter((entry) => entry.metadata.playerName && entry.metadata.year);
  if (!parsedCandidates.length) return null;

  const groups = new Map();
  for (const entry of parsedCandidates) {
    const key = `${entry.metadata.year}:${cleanTitle(entry.metadata.playerName).toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const rankedGroups = [...groups.values()].sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    const aRank = Number.isFinite(a[0].comp.imageRank) ? a[0].comp.imageRank : Number.POSITIVE_INFINITY;
    const bRank = Number.isFinite(b[0].comp.imageRank) ? b[0].comp.imageRank : Number.POSITIVE_INFINITY;
    if (aRank !== bRank) return aRank - bRank;
    return (b[0].comp.matchScore || 0) - (a[0].comp.matchScore || 0);
  });
  const supportingGroup = rankedGroups[0] || [];
  const best = supportingGroup[0] || null;
  if (!best) return null;

  const usefulSetTokens = cleanTitle(best.metadata.setName || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(
      (token) =>
        token.length > 2 &&
        !["panini", "topps", "upper", "deck", "nba", "nfl", "mlb", "ufc", "card", "cards"].includes(
          token,
        ),
    );
  const imageRank = Number.isFinite(best.comp.imageRank)
    ? best.comp.imageRank
    : Number.POSITIVE_INFINITY;
  const reliable =
    supportingGroup.length >= 2 ||
    best.comp.kind === "sold" ||
    Boolean(best.metadata.cardNumber) ||
    (imageRank <= 8 && usefulSetTokens.length > 0);
  if (!reliable) return null;

  const title = best.title;
  const metadata = best.metadata;
  return {
    ...metadata,
    confidence: supportingGroup.length >= 2 ? 0.78 : 0.62,
    provider: "ebay_image_search",
    notes: `eBay image/title inference (${supportingGroup.length} supporting): ${title}`,
    titleHint: title,
  };
}

function isAmbiguousChoiceComp(comp = {}) {
  return isAmbiguousChoiceTitle(comp?.title || "");
}

function namesLikelyMatch(a, b) {
  const left = cleanTitle(a).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const right = cleanTitle(b).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!left || !right) return true;
  return left === right || left.includes(right) || right.includes(left);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export function mergeDetectedMetadata(preserved, heuristic, ebay) {
  const detected = ebay || {};
  const preferredCardNumber = isWeakCardNumber(preserved.cardNumber)
    ? detected.cardNumber ?? heuristic.cardNumber ?? preserved.cardNumber ?? null
    : preserved.cardNumber ?? detected.cardNumber ?? heuristic.cardNumber ?? null;
  const mergedParallel =
    isWeakParallelLabel(preserved.parallel) && !isWeakParallelLabel(detected.parallel)
      ? detected.parallel ?? heuristic.parallel ?? preserved.parallel ?? null
      : preserved.parallel ?? detected.parallel ?? heuristic.parallel ?? null;
  const mergedSetName = preserved.setName ?? detected.setName ?? heuristic.setName ?? null;
  const mergedYearBeforeSetNameCheck = preserved.year ?? detected.year ?? heuristic.year ?? null;
  const setNameYear = extractYearFromSetName(mergedSetName);
  // Confirmed live: a Tee Higgins Donruss card merged year:2023 with
  // setName:"2024 PANINI DONRUSS FOOTBALL" — two different OCR/vision
  // passes disagreeing — producing a self-contradictory comp-search query
  // ("2023 ... 2024 ...") that found zero real sold matches for an
  // otherwise common, liquid card. Prefer the year embedded in the set
  // name when the two disagree.
  const mergedYear =
    setNameYear && mergedYearBeforeSetNameCheck && setNameYear !== mergedYearBeforeSetNameCheck
      ? setNameYear
      : mergedYearBeforeSetNameCheck;
  return {
    ...preserved,
    ...heuristic,
    ...detected,
    playerName: preserved.playerName ?? detected.playerName ?? heuristic.playerName ?? null,
    year: mergedYear,
    setName: mergedSetName,
    cardNumber: preferredCardNumber,
    parallel: mergedParallel,
    // A confidently-detected, specific parallel (not a weak/generic label —
    // see isWeakParallelLabel) always overrides baseHint, no matter which
    // source's OR-chain below set it true. Without this, baseHint could
    // survive from an earlier, less-informed pass (or a different source
    // entirely) even after mergedParallel above resolved to a real insert
    // name — confirmed live: a card correctly identified as an "UNSTOPPABLE"
    // /8 parallel still carried baseHint:true, which downstream disabled all
    // parallel-based comp filtering in pricing.js and let an unrelated,
    // differently-named parallel's sold price anchor the recommended price.
    baseHint:
      mergedParallel && !isWeakParallelLabel(mergedParallel)
        ? false
        : preserved.baseHint || heuristic.baseHint || (!detected.parallel && Boolean(detected.playerName)),
    grade: preserved.grade ?? heuristic.grade ?? null,
    gradedFlag: preserved.gradedFlag || Boolean(heuristic.gradedFlag),
    compGradeOverride: preserved.compGradeOverride,
    compMatchMode: preserved.compMatchMode,
    serialNumber: preserved.serialNumber ?? detected.serialNumber ?? heuristic.serialNumber ?? null,
    printRun: preserved.printRun ?? detected.printRun ?? heuristic.printRun ?? null,
    rookieFlag:
      preserved.rookieFlag || Boolean(detected.rookieFlag) || Boolean(heuristic.rookieFlag),
    variantLabel:
      isWeakParallelLabel(preserved.parallel) && detected.variantLabel
        ? detected.variantLabel
        : preserved.variantLabel ?? detected.variantLabel ?? heuristic.variantLabel ?? null,
    autographFlag:
      preserved.autographFlag || Boolean(detected.autographFlag) || Boolean(heuristic.autographFlag),
    team: preserved.team ?? heuristic.team ?? null,
    league: preserved.league ?? heuristic.league ?? null,
    sport: detected.sport ?? heuristic.sport ?? null,
    confidence: detected.confidence ?? heuristic.confidence ?? 0.45,
    provider: detected.provider || heuristic.provider || "heuristic",
    identityProvider: heuristic.identityProvider || preserved.identityProvider || detected.identityProvider || null,
    parallelProvider:
      preserved.parallelProvider ||
      (preserved.parallel ? heuristic.parallelProvider || heuristic.identityProvider || null : null) ||
      (mergedParallel === heuristic.parallel
        ? heuristic.parallelProvider || heuristic.identityProvider || null
        : detected.parallelProvider || detected.provider || null),
    notes: [heuristic.notes, detected.notes].filter(Boolean).join(" | ") || "eBay processing",
    titleHint: detected.titleHint || heuristic.titleHint || "",
  };
}

// Reads everything processCardItemInState needs to run. Runs under a
// read-only state lock (no write, no I/O), so it releases the lock
// immediately. The card item is shallow-cloned so downstream computation
// mutates a detached object rather than the live state reference.
function readCardSnapshot(state, cardItemId) {
  const cardItem = state.cardItems.find((item) => item.id === cardItemId);
  if (!cardItem) {
    throw new Error(`Card item not found: ${cardItemId}`);
  }
  const frontImage = state.cardImages.find((image) => image.id === cardItem.frontImageId);
  const backImage = state.cardImages.find((image) => image.id === cardItem.backImageId);
  const offers = state.offers.filter((offer) => offer.cardItemId === cardItemId);
  return { cardItem: { ...cardItem }, frontImage, backImage, offers };
}

// Runs OCR, Apify, and eBay Browse comp lookups and computes the full set of
// card-field updates and pricing. Does NOT hold the state lock, so this is
// where all the slow network I/O actually happens — many cards can run this
// concurrently. Operates on a detached `cardItem` clone (from
// readCardSnapshot), so it's safe to mutate freely without touching live
// state. Returns the computed card fields plus any keys that were deleted
// from it (e.g. `delete cardItem.apifyError`), since writeCardResult needs to
// replay those deletions onto the live object.
//
// Known trade-off: this runs on a snapshot taken before the network calls, so
// if a user edits this same card (e.g. review overrides, excluded comps)
// while it's mid-flight, that edit can be silently overwritten when the
// result is merged back in writeCardResult. writeCardResult re-derives
// publish status against fresh data specifically because that's the highest-
// value, most reachable case (see the comment there) — this broader class of
// edit-during-processing races is accepted as a known limitation rather than
// solved generically here.
async function computeCardResult({ cardItem: snapshotCardItem, frontImage, backImage, offers }) {
  const cardItem = { ...snapshotCardItem };
  const originalKeys = new Set(Object.keys(cardItem));
  const cardItemId = cardItem.id;

  const titleMetadata = inferMetadataFromTitle(cardItem.ebayTitle || cardItem.title || "", {
    provider: "existing_title",
    notesPrefix: "Existing listing title",
  });
  // extractCardMetadata had no ceiling of its own — confirmed live
  // 2026-07-24: a card sat at ocr_pending indefinitely with zero log output,
  // because nothing here bounded the OCR/vision call the way every other
  // network call in this codebase does (see withTimeout in app.js). Wrapping
  // it here means a hang now surfaces as a clean, logged failure that
  // processBatch's existing error handling already knows how to recover
  // from (clears processingBatchIds, marks the batch needs_review) instead
  // of an infinite silent stall. Not imported from app.js: app.js imports
  // FROM pipeline.js, so that import would be circular.
  const heuristic = await withPipelineStepTimeout(
    extractCardMetadata({
      frontText: frontImage?.ocrText || "",
      backText: backImage?.ocrText || "",
      frontFileName: frontImage?.fileName || "",
      backFileName: backImage?.fileName || "",
      frontImagePath: frontImage?.storagePath || "",
      backImagePath: backImage?.storagePath || "",
      // Was hardcoded false, which silently defeated OCR_PROVIDER=openai:
      // when Ximilar isn't primary (not configured, or OCR_PROVIDER=openai),
      // extractCardMetadata() falls through past the useXimilarPrimary block
      // and checks THIS flag before running full front+back OpenAI vision —
      // with it false, that check always failed too, so every card fell all
      // the way through to the heuristic-only result plus a narrow
      // parallel-only probe (no real player/card-number/sport/autograph
      // reading at all). extractCardMetadata's own useXimilarPrimary check is
      // already the single source of truth for provider selection, so it's
      // safe to always allow OpenAI here — when Ximilar is primary the
      // function returns before ever consulting this flag.
      allowOpenAI: true,
      allowOpenAIParallel: true,
    }),
    { label: "OCR/vision identification", envVar: "OCR_TIMEOUT_MS", defaultMs: 180000 },
  );

  const isPublishedCard =
    cardItem.status === "listed" ||
    cardItem.publishState === "published" ||
    Boolean(cardItem.listingId || cardItem.listingUrl);
  const preservePriorIdentity =
    isPublishedCard &&
    cardItem.ocrProvider !== "ebay_image_search" &&
    cardItem.compSource !== "ebay_image_search" &&
    !isAmbiguousChoiceTitle(cardItem.ocrNotes || "");
  const reviewOverrides = cardItem.reviewOverrides || {};
  const useSavedValue = (key) => Boolean(reviewOverrides[key]) || preservePriorIdentity;
  const trustedTitleMetadata = preservePriorIdentity ? titleMetadata : null;
  const preserved = {
    playerName: useSavedValue("candidatePlayer")
      ? cardItem.candidatePlayer || null
      : trustedTitleMetadata?.playerName || heuristic.playerName || null,
    year: useSavedValue("candidateYear") ? cardItem.candidateYear || null : trustedTitleMetadata?.year || heuristic.year || null,
    setName: useSavedValue("candidateSetName")
      ? cardItem.candidateSetName || null
      : trustedTitleMetadata?.setName || heuristic.setName || null,
    cardNumber: useSavedValue("candidateCardNumber")
      ? cardItem.candidateCardNumber || null
      : trustedTitleMetadata?.cardNumber || heuristic.cardNumber || null,
    parallel: useSavedValue("candidateParallel")
      ? cardItem.candidateParallel || null
      : trustedTitleMetadata?.parallel || heuristic.parallel || null,
    baseHint: useSavedValue("candidateBaseHint")
      ? Boolean(cardItem.candidateBaseHint)
      : Boolean(trustedTitleMetadata && !trustedTitleMetadata.parallel),
    grade: useSavedValue("candidateGrade") ? cardItem.candidateGrade || null : null,
    gradedFlag:
      useSavedValue("candidateGrade") ||
      useSavedValue("gradingCompany") ||
      useSavedValue("certificationNumber")
        ? cardItem.candidateCondition === "graded"
        : false,
    gradingCompany: useSavedValue("gradingCompany") ? cardItem.gradingCompany || null : null,
    certificationNumber: useSavedValue("certificationNumber") ? cardItem.certificationNumber || null : null,
    compGradeOverride: cardItem.compGradeOverride || null,
    compMatchMode: cardItem.compMatchMode || "auto",
    rookieFlag: useSavedValue("candidateRookieFlag")
      ? Boolean(cardItem.candidateRookieFlag)
      : Boolean(trustedTitleMetadata?.rookieFlag || heuristic.rookieFlag),
    autographFlag: useSavedValue("candidateAutoHint")
      ? Boolean(cardItem.candidateAutoHint)
      : Boolean(trustedTitleMetadata?.autographFlag || heuristic.autographFlag),
    variantLabel: useSavedValue("candidateRookieFlag")
      ? cardItem.candidateVariantLabel || null
      : trustedTitleMetadata?.variantLabel || heuristic.variantLabel || null,
    serialNumber: useSavedValue("serialNumber") ? cardItem.serialNumber || null : trustedTitleMetadata?.serialNumber || null,
    printRun: useSavedValue("printRun") ? cardItem.printRun || null : trustedTitleMetadata?.printRun || null,
    team: useSavedValue("candidateTeam") ? cardItem.candidateTeam || null : heuristic.team || null,
    league: useSavedValue("candidateLeague") ? cardItem.candidateLeague || null : heuristic.league || null,
  };
  let mergedOcr = mergeDetectedMetadata(preserved, heuristic, null);
  let match = matchCardIdentity(mergedOcr);
  const existingSoldComps = Array.isArray(cardItem.externalSoldComps) ? cardItem.externalSoldComps : [];
  let apifySoldComps = existingSoldComps;
  const apifyLookupKey = buildApifyLookupKey(mergedOcr);
  if (hasSoldCompsProvider() && (cardItem.apifyLookupKey !== apifyLookupKey || !apifySoldComps.length)) {
    try {
      const apifyResult = await withPipelineStepTimeout(searchSoldListings(mergedOcr), {
        label: "Sold-comp lookup",
        envVar: "PIPELINE_COMP_LOOKUP_TIMEOUT_MS",
        // Generous enough for the auto chain's worst case: a full Apify
        // attempt timing out (~20s) THEN a real two-keyword scrape through
        // the residential proxy.
        defaultMs: 90000,
      });
      apifySoldComps = apifyResult.comps.slice(0, 50);
      cardItem.externalSoldComps = apifySoldComps;
      cardItem.apifyLookupKey = apifyLookupKey;
      cardItem.apifySearchKeywords = apifyResult.keywordsUsed || [];
      cardItem.apifySearchQuery = Array.isArray(apifyResult.keywordsUsed)
        ? apifyResult.keywordsUsed.join(" · ")
        : null;
      cardItem.externalCompSource = apifyResult.source || "soldcomps";
      cardItem.externalCompUpdatedAt = nowIso();
      delete cardItem.apifyError;
    } catch (error) {
      cardItem.apifyError = error.message;
    }
  }
  let comps = await withPipelineStepTimeout(
    getLiveCardComps(
      {
        ...mergedOcr,
        allowImageOnlyMatches: true,
        fastMode: true,
        titleHint: mergedOcr.titleHint || cardItem.ebayTitle || cardItem.title || "",
      },
      frontImage?.storagePath || null,
      backImage?.storagePath || null,
      match.canonicalCard,
      apifySoldComps,
    ),
    { label: "Live comp lookup", envVar: "PIPELINE_COMP_LOOKUP_TIMEOUT_MS", defaultMs: 45000 },
  );
  const preliminaryRelevantComps = {
    sold: dedupeComps(comps.sold).filter((comp) => isRelevantComp(comp, mergedOcr)),
    active: comps.active.filter((comp) => isRelevantComp(comp, mergedOcr)),
  };
  const ebayMetadata = inferMetadataFromEbayComps(preliminaryRelevantComps);
  const anchoredPlayer = preserved.playerName || heuristic.playerName || null;
  const needsEbayFieldFallback =
    !preserved.setName || isWeakCardNumber(preserved.cardNumber) || isWeakParallelLabel(preserved.parallel);
  if (
    ebayMetadata &&
    (!anchoredPlayer ||
      namesLikelyMatch(anchoredPlayer, ebayMetadata.playerName) ||
      needsEbayFieldFallback)
  ) {
    mergedOcr = mergeDetectedMetadata(preserved, heuristic, ebayMetadata);
    match = matchCardIdentity(mergedOcr);
  }
  const excludedIds = new Set(cardItem.excludedCompIds || []);
  const isExcluded = (comp) =>
    [comp.listingId, comp.id, comp.url].some((k) => k && excludedIds.has(k));
  const pricingStrategy = choosePricingStrategy(mergedOcr);
  const soldComps = dedupeComps(comps.sold).filter(
    (comp) => !isExcluded(comp) && !isAmbiguousChoiceComp(comp) && isRelevantComp(comp, mergedOcr),
  );
  const activeFiltered = comps.active.filter(
    (comp) => !isExcluded(comp) && !isAmbiguousChoiceComp(comp) && isRelevantComp(comp, mergedOcr),
  );
  const pricing = calculatePrice({
    soldComps,
    activeListings: activeFiltered,
    strategy: pricingStrategy,
    metadata: {
      parallel: mergedOcr.parallel,
      baseHint: Boolean(mergedOcr.baseHint),
      variantLabel: mergedOcr.variantLabel,
      rookieFlag: Boolean(mergedOcr.rookieFlag),
      serialNumber: mergedOcr.serialNumber,
      printRun: mergedOcr.printRun,
    },
  });

  cardItem.candidatePlayer = mergedOcr.playerName;
  cardItem.candidateSport = mergedOcr.sport;
  cardItem.candidateYear = mergedOcr.year;
  cardItem.candidateSetName = mergedOcr.setName;
  cardItem.candidateCardNumber = mergedOcr.cardNumber;
  cardItem.candidateParallel = mergedOcr.parallel;
  cardItem.candidateBaseHint = Boolean(mergedOcr.baseHint);
  cardItem.candidateAutoHint = Boolean(mergedOcr.autographFlag);
  cardItem.candidateGrade = mergedOcr.grade;
  cardItem.candidateCondition = mergedOcr.gradedFlag ? "graded" : "raw";
  cardItem.gradingCompany = mergedOcr.gradingCompany || null;
  cardItem.certificationNumber = mergedOcr.certificationNumber || null;
  cardItem.candidateRookieFlag = Boolean(mergedOcr.rookieFlag);
  cardItem.candidateVariantLabel = mergedOcr.variantLabel || null;
  cardItem.candidateTeam = mergedOcr.team || null;
  cardItem.candidateLeague = mergedOcr.league || null;
  cardItem.serialNumber = mergedOcr.serialNumber || null;
  cardItem.printRun = mergedOcr.printRun || null;

  // Manual price check off the scan filename ("LebronJames$7-01.jpg" -> 7).
  // Cards are scanned with eBay's card scanner and the scanner writes the
  // price they judged into the filename, so this is a HUMAN read — worth
  // more than anything the app currently derives on its own, since sold
  // comps went behind eBay's login wall and the app's pricing is otherwise
  // inferred from other sellers' asks. Recorded here as evidence only; it
  // does not silently override the computed price.
  const manualPrice = resolveManualPriceFromFileNames(frontImage?.fileName, backImage?.fileName);
  if (manualPrice.price != null) {
    cardItem.manualPriceCheck = manualPrice.price;
    cardItem.manualPriceCheckSource = `filename:${manualPrice.source}`;
    cardItem.manualPriceCheckAt = nowIso();
    cardItem.manualPriceCheckConflict = manualPrice.conflict;
    // Deliberately NOT appended to ocrNotes: that field is reassigned
    // wholesale from mergedOcr.notes further down this same function, so
    // anything written to it here would be silently discarded.
    cardItem.manualPriceCheckNote = manualPrice.note || null;
  } else {
    // Clear stale values so a re-scan without a price in the filename
    // doesn't leave a previous run's number sitting there looking current.
    delete cardItem.manualPriceCheck;
    delete cardItem.manualPriceCheckSource;
    delete cardItem.manualPriceCheckAt;
    delete cardItem.manualPriceCheckConflict;
    delete cardItem.manualPriceCheckNote;
  }
  const metadataConfidence = typeof mergedOcr.confidence === "number" ? mergedOcr.confidence : 0.45;
  cardItem.confidenceScore = Number(
    (match.canonicalCard ? (metadataConfidence + match.confidence) / 2 : metadataConfidence).toFixed(2),
  );
  cardItem.canonicalCardId = match.canonicalCard?.id || null;
  // The scanner's filename price is a HUMAN read and outranks anything the
  // app infers right now — sold comps are gone (eBay sign-in wall), so the
  // computed figure comes from other sellers' ASKS. Anchor to the human
  // number, but let a genuinely hot market pull the price UP (capped at
  // MANUAL_ANCHOR_MAX_MULTIPLE) so a card that popped off after it was
  // scanned isn't stuck at a stale valuation.
  const anchoredPrice = applyManualPriceAnchor(
    pricing.recommendedPrice,
    cardItem.manualPriceCheck,
    // Relevance-filtered sold comps only — the same set that fed calculatePrice.
    // Once there are enough real completed sales, they lead and the manual
    // filename read stops clamping the price.
    { soldCompCount: soldComps.length },
  );
  cardItem.recommendedPrice = anchoredPrice.price ?? pricing.recommendedPrice;
  cardItem.priceAnchorBasis = anchoredPrice.basis;
  cardItem.priceAnchorReason = anchoredPrice.reason;
  cardItem.marketPriceBeforeAnchor = anchoredPrice.marketPrice ?? pricing.recommendedPrice ?? null;
  cardItem.currency = "USD";
  cardItem.pricingStrategy = pricing.strategy;
  cardItem.pricingConfidence = pricing.confidence;
  cardItem.pricingReason = pricing.reason;
  cardItem.pricingEvidence = pricing.evidence;
  cardItem.externalSoldComps = soldComps.slice(0, 50);
  const hasAnyComps = Boolean(soldComps.length || activeFiltered.length);
  // The sold-comp fetch above already stamped externalCompSource with the
  // provider that actually answered ("apify" or "ebay_scraper") — keep it
  // rather than re-deriving from config here, which mislabeled scraper
  // results as "soldcomps" once the provider chain existed.
  const compSource =
    hasSoldCompsProvider() && !cardItem.apifyError
      ? cardItem.externalCompSource || "soldcomps"
      : hasAnyComps
        ? "ebay_image_search"
        : cardItem.externalCompSource || null;
  const strongIdentity =
    Boolean(mergedOcr.playerName) &&
    Boolean(mergedOcr.year) &&
    Boolean(mergedOcr.setName) &&
    !isWeakCardNumber(mergedOcr.cardNumber);
  const trustedIdentityProvider = new Set(["surya", "apple_vision", "existing_title", "ebay_image_search"]).has(
    mergedOcr.identityProvider || mergedOcr.provider || "",
  );
  const autoPricedCandidate =
    strongIdentity &&
    trustedIdentityProvider &&
    hasAnyComps &&
    Number.isFinite(pricing.recommendedPrice) &&
    pricing.recommendedPrice > 0;
  const suryaReadyCard =
    (mergedOcr.identityProvider || mergedOcr.provider || "") === "surya" &&
    Boolean(cardItem.candidatePlayer) &&
    Boolean(cardItem.candidateYear) &&
    Boolean(cardItem.candidateSetName) &&
    !isWeakCardNumber(cardItem.candidateCardNumber) &&
    Number.isFinite(cardItem.recommendedPrice) &&
    cardItem.recommendedPrice > 0;
  cardItem.externalCompSource = compSource;
  cardItem.externalCompUpdatedAt = hasAnyComps ? nowIso() : cardItem.externalCompUpdatedAt || null;
  cardItem.externalPricingSummary = buildExternalPricingSummary(
    pricing,
    soldComps,
    activeFiltered,
    compSource || "ebay_image_search",
  );
  delete cardItem.apifyError;
  cardItem.marketDataSource = comps.active.some((comp) => comp.source === "browse_active")
    ? "ebay_browse"
    : "local";
  if (mergedOcr.titleHint && !cardItem.ebayTitle) {
    cardItem.ebayTitle = mergedOcr.titleHint;
  }
  cardItem.ocrProvider = mergedOcr.identityProvider || mergedOcr.provider || "heuristic";
  cardItem.identityProvider = mergedOcr.identityProvider || mergedOcr.provider || "heuristic";
  cardItem.parallelProvider = mergedOcr.parallelProvider || null;
  cardItem.compMatchProvider = cardItem.externalCompSource || null;
  cardItem.ocrNotes = mergedOcr.notes;
  cardItem.identityDisagreement = mergedOcr.verificationDisagreement || null;
  if (isCardEffectivelyPublished(cardItem, offers)) {
    cardItem.status = "listed";
    cardItem.publishState = "published";
  } else if (suryaReadyCard || autoPricedCandidate) {
    cardItem.status = "priced";
  } else if (cardItem.status !== "ready") {
    cardItem.status = cardItem.confidenceScore < 0.65 ? "needs_review" : "priced";
  }
  if (
    !isCardEffectivelyPublished(cardItem, offers) &&
    (mergedOcr.identityProvider || mergedOcr.provider || "") === "surya" &&
    Boolean(cardItem.candidatePlayer) &&
    Boolean(cardItem.candidateYear) &&
    Boolean(cardItem.candidateSetName) &&
    (!isWeakCardNumber(cardItem.candidateCardNumber) ||
      (isInsertStyleCardNumber(cardItem.candidateCardNumber) &&
        Boolean(cardItem.candidateParallel) &&
        activeFiltered.length >= 1)) &&
    Number.isFinite(cardItem.recommendedPrice) &&
    cardItem.recommendedPrice > 0 &&
    activeFiltered.length >= 1
  ) {
    cardItem.status = "priced";
  }
  if (
    !isCardEffectivelyPublished(cardItem, offers) &&
    (!Number.isFinite(cardItem.recommendedPrice) || cardItem.recommendedPrice <= 0)
  ) {
    cardItem.status = "needs_review";
  }
  cardItem.updatedAt = nowIso();

  const deletedKeys = [...originalKeys].filter((key) => !(key in cardItem));
  // Persist the already-relevance-filtered soldComps/activeFiltered (player,
  // year, set, card#, and now parallel) rather than the raw `comps` — that
  // raw active list still carries whatever searchEbayListings backfilled in
  // as "filler" results when strict matches were scarce (confirmed live
  // 2026-07-13: a Dereck Lively card's stored comps included Ja Morant,
  // Markelle Fultz, and Julian Strawther listings pulled in via image-only
  // matching at match scores of 2, with nothing downstream filtering them
  // back out before they reached state.comps).
  return { cardItem, comps: { sold: soldComps, active: activeFiltered }, deletedKeys };
}

// Persists a computed result back onto the card. Does no network I/O; runs
// under the state lock just long enough to merge fields, rebuild the comps
// table, and write the audit event.
async function writeCardResult(cardItemId, result) {
  return withState(async (state) => {
    const cardItem = state.cardItems.find((item) => item.id === cardItemId);
    if (!cardItem) {
      throw new Error(`Card item not found: ${cardItemId}`);
    }
    Object.assign(cardItem, result.cardItem);
    for (const key of result.deletedKeys) {
      delete cardItem[key];
    }

    // computeCardResult ran unlocked and may have decided status/publishState
    // from an `offers` snapshot that's now stale (e.g. this card was published
    // while OCR/comp lookups were in flight). Re-derive against FRESH offers
    // here so a concurrent publish can't be clobbered back to
    // priced/needs_review by a stale computation. isCardEffectivelyPublished
    // took first priority in the original single-locked function too.
    const freshOffers = state.offers.filter((offer) => offer.cardItemId === cardItemId);
    if (isCardEffectivelyPublished(cardItem, freshOffers)) {
      cardItem.status = "listed";
      cardItem.publishState = "published";
    }

    state.comps = state.comps.filter((comp) => comp.cardItemId !== cardItemId);
    for (const comp of result.comps.sold) {
      state.comps.push({
        id: createId(state, "comp"),
        cardItemId,
        createdAt: nowIso(),
        ...normalizeStoredComp(comp, comp.source || "sold"),
      });
    }
    for (const comp of result.comps.active) {
      state.comps.push({
        id: createId(state, "comp"),
        cardItemId,
        createdAt: nowIso(),
        ...normalizeStoredComp(comp, "browse_active"),
      });
    }

    createAuditEvent(state, "cardItem", cardItemId, "processed", {
      confidence: cardItem.confidenceScore,
      canonicalCardId: cardItem.canonicalCardId,
      recommendedPrice: cardItem.recommendedPrice,
    });

    return cardItem;
  });
}

export async function processCardItem(cardItemId) {
  const snapshot = await withStateReadOnly(async (state) => readCardSnapshot(state, cardItemId));
  const result = await computeCardResult(snapshot);
  return writeCardResult(cardItemId, result);
}

// Statuses that mean a card already has real, usable OCR/pricing data —
// processBatch() skips these rather than blindly reprocessing every card
// in the batch. Confirmed live via the Apify run console: adding one new
// card to an existing, already-processed batch and clicking "Process"
// re-ran EVERY other card in that batch too, each burning a fresh (paid)
// Apify sold-comp lookup, because OCR/vision is non-deterministic between
// runs — a card's re-derived apifyLookupKey rarely matches its cached one
// even when nothing about the card actually needed to change. A single
// card's dedicated "Process" button (processCardItem called directly) is
// unaffected — that's an explicit, deliberate reprocess of one card and
// stays available for exactly that.
const ALREADY_PROCESSED_STATUSES = new Set(["priced", "ready", "listed", "sold", "sent_to_grading"]);

export function needsBatchProcessing(card = {}) {
  return !ALREADY_PROCESSED_STATUSES.has(card.status);
}

// Tracks which batches are actively being processed by THIS process right
// now. batch.status === "processing" alone can't distinguish a live run from
// one that crashed or was killed mid-run, since that status is committed as
// its own durable write before any card processing happens (see
// processBatch below) — a killed process leaves that write behind with
// nothing left to ever move it forward. This Set starts empty on every
// server boot, which is exactly the signal we want: any batch still showing
// "processing" from before a restart is, by definition, not actually running.
const processingBatchIds = new Set();

export function isBatchProcessing(batchId) {
  return processingBatchIds.has(batchId);
}

// Pure and testable: given a batch, its cards, and whether THIS process
// currently has it marked as actively running, decides whether it's
// genuinely stuck versus a live in-flight run, plus a per-status card
// breakdown for the UI tooltip.
export function describeBatchProcessingState(batch, cards = [], isActivelyProcessing = false) {
  const cardBreakdown = {};
  for (const card of Array.isArray(cards) ? cards : []) {
    const status = card?.status || "unknown";
    cardBreakdown[status] = (cardBreakdown[status] || 0) + 1;
  }
  const stuck = batch?.status === "processing" && !isActivelyProcessing;
  return {
    stuck,
    reason: stuck
      ? 'Marked "processing" but nothing is actively running — likely interrupted by a restart or crash. Click Process to resume; already-processed cards are skipped automatically.'
      : null,
    cardBreakdown,
  };
}

export async function processBatch(batchId) {
  processingBatchIds.add(batchId);
  try {
    const cardIds = await withState(async (state) => {
      const batch = state.batches.find((entry) => entry.id === batchId);
      if (!batch) throw new Error(`Batch not found: ${batchId}`);
      batch.status = "processing";
      batch.updatedAt = nowIso();
      return state.cardItems
        .filter((item) => item.batchId === batchId && needsBatchProcessing(item))
        .map((item) => item.id);
    });

    const concurrency = Math.max(
      1,
      Math.min(4, Number.parseInt(process.env.CARD_PROCESS_CONCURRENCY || "3", 10) || 3),
    );

    // batch.status = "processing" was already committed above as its own write,
    // so — unlike the original single-locked version, where an uncaught error
    // here would roll back that write too — a per-card failure would otherwise
    // leave the batch permanently stuck at "processing" with no automatic
    // recovery. Catch it, still finalize the batch from whatever cards did
    // complete, then re-throw so the caller sees the same failure it always did
    // (the route handler has no try/catch and relies on this propagating to the
    // top-level 500 handler).
    let processingError = null;
    try {
      await runWithConcurrency(cardIds, concurrency, async (cardItemId) => {
        await processCardItem(cardItemId);
        await sleep(150);
      });
    } catch (error) {
      processingError = error;
    }

    const finalizedBatch = await withState(async (state) => {
      const batch = state.batches.find((entry) => entry.id === batchId);
      if (!batch) throw new Error(`Batch not found: ${batchId}`);
      const refreshed = state.cardItems.filter((item) => item.batchId === batchId);
      const allReady = refreshed.every((item) =>
        item.status === "priced" || item.status === "ready" || item.status === "listed",
      );
      batch.status = processingError ? "needs_review" : allReady ? "ready_to_publish" : "needs_review";
      batch.updatedAt = nowIso();

      createAuditEvent(state, "batch", batchId, "processed", {
        cardCount: cardIds.length,
        ready: allReady,
        error: processingError ? processingError.message : undefined,
      });

      return batch;
    });

    if (processingError) throw processingError;
    return finalizedBatch;
  } finally {
    processingBatchIds.delete(batchId);
  }
}
