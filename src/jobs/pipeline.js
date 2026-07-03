import { extractCardMetadata } from "../services/ocr.js";
import { matchCardIdentity } from "../services/matching.js";
import { getLiveCardComps } from "../services/comps.js";
import { buildApifyLookupKey, hasApifyConfig, searchApifySoldListings } from "../services/apify.js";
import { calculatePrice } from "../services/pricing.js";
import { createAuditEvent, createId, nowIso, withState, withStateReadOnly } from "../lib/store.js";

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

function isRelevantComp(comp, metadata) {
  return (
    compMentionsPlayer(comp, metadata?.playerName) &&
    compMatchesCardNumber(comp, metadata?.cardNumber) &&
    compMatchesSet(comp, metadata?.setName)
  );
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
  if (!serial) return { serialNumber: null, printRun: null };
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

function inferMetadataFromTitle(title, { provider = "ebay_title", notesPrefix = "eBay title" } = {}) {
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

function mergeDetectedMetadata(preserved, heuristic, ebay) {
  const detected = ebay || {};
  const preferredCardNumber = isWeakCardNumber(preserved.cardNumber)
    ? detected.cardNumber ?? heuristic.cardNumber ?? preserved.cardNumber ?? null
    : preserved.cardNumber ?? detected.cardNumber ?? heuristic.cardNumber ?? null;
  const mergedParallel =
    isWeakParallelLabel(preserved.parallel) && !isWeakParallelLabel(detected.parallel)
      ? detected.parallel ?? heuristic.parallel ?? preserved.parallel ?? null
      : preserved.parallel ?? detected.parallel ?? heuristic.parallel ?? null;
  return {
    ...preserved,
    ...heuristic,
    ...detected,
    playerName: preserved.playerName ?? detected.playerName ?? heuristic.playerName ?? null,
    year: preserved.year ?? detected.year ?? heuristic.year ?? null,
    setName: preserved.setName ?? detected.setName ?? heuristic.setName ?? null,
    cardNumber: preferredCardNumber,
    parallel: mergedParallel,
    baseHint: preserved.baseHint || heuristic.baseHint || (!detected.parallel && Boolean(detected.playerName)),
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
  const heuristic = await extractCardMetadata({
    frontText: frontImage?.ocrText || "",
    backText: backImage?.ocrText || "",
    frontFileName: frontImage?.fileName || "",
    backFileName: backImage?.fileName || "",
    frontImagePath: frontImage?.storagePath || "",
    backImagePath: backImage?.storagePath || "",
    allowOpenAI: false,
    allowOpenAIParallel: true,
  });

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
  if (hasApifyConfig() && (cardItem.apifyLookupKey !== apifyLookupKey || !apifySoldComps.length)) {
    try {
      const apifyResult = await searchApifySoldListings(mergedOcr);
      apifySoldComps = apifyResult.comps.slice(0, 50);
      cardItem.externalSoldComps = apifySoldComps;
      cardItem.apifyLookupKey = apifyLookupKey;
      cardItem.apifySearchKeywords = apifyResult.keywordsUsed || [];
      cardItem.apifySearchQuery = Array.isArray(apifyResult.keywordsUsed)
        ? apifyResult.keywordsUsed.join(" · ")
        : null;
      cardItem.externalCompSource = "apify";
      cardItem.externalCompUpdatedAt = nowIso();
      delete cardItem.apifyError;
    } catch (error) {
      cardItem.apifyError = error.message;
    }
  }
  let comps = await getLiveCardComps(
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
  const metadataConfidence = typeof mergedOcr.confidence === "number" ? mergedOcr.confidence : 0.45;
  cardItem.confidenceScore = Number(
    (match.canonicalCard ? (metadataConfidence + match.confidence) / 2 : metadataConfidence).toFixed(2),
  );
  cardItem.canonicalCardId = match.canonicalCard?.id || null;
  cardItem.recommendedPrice = pricing.recommendedPrice;
  cardItem.currency = "USD";
  cardItem.pricingStrategy = pricing.strategy;
  cardItem.pricingConfidence = pricing.confidence;
  cardItem.pricingReason = pricing.reason;
  cardItem.pricingEvidence = pricing.evidence;
  cardItem.externalSoldComps = soldComps.slice(0, 50);
  const hasAnyComps = Boolean(soldComps.length || activeFiltered.length);
  const compSource =
    hasApifyConfig() && !cardItem.apifyError
      ? "apify"
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
  cardItem.cardhedgePricingSummary = buildExternalPricingSummary(
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
  return { cardItem, comps, deletedKeys };
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
    for (const comp of [...result.comps.sold, ...result.comps.active]) {
      state.comps.push({
        id: createId(state, "comp"),
        cardItemId,
        source: comp.kind === "sold" ? comp.source : "browse_active",
        listingId: comp.id,
        title: comp.title,
        conditionLabel: comp.conditionLabel,
        salePrice: comp.salePrice ?? null,
        shippingPrice: comp.shippingPrice ?? null,
        totalPrice: comp.totalPrice ?? comp.price ?? null,
        soldAt: comp.soldAt ?? null,
        url: comp.url ?? null,
        matchScore: comp.matchScore ?? null,
        rawPayload: comp,
        createdAt: nowIso(),
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

export async function processBatch(batchId) {
  const cardIds = await withState(async (state) => {
    const batch = state.batches.find((entry) => entry.id === batchId);
    if (!batch) throw new Error(`Batch not found: ${batchId}`);
    batch.status = "processing";
    batch.updatedAt = nowIso();
    return state.cardItems.filter((item) => item.batchId === batchId).map((item) => item.id);
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
}
