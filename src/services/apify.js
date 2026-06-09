import { nowIso } from "../lib/store.js";

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanQueryText(value) {
  return String(value || "").replace(/["'“”]/g, "").trim();
}

function hasExplicitVariantSignals(title) {
  const haystack = normalize(title);
  if (!haystack) return false;
  if (/\bbase\b/.test(haystack) || /\bbase card\b/.test(haystack)) return false;
  return /(?:refractor|prizm|prism|wave|holo|atomic|sparkle|shimmer|die cut|diecut|mojo|scope|hyper|ice|gold|silver|blue|green|red|orange|purple|black|pink|aqua|emerald|lava|laser|raywave|stardust|cracked ice|pulsar|finite|numbered)\b/.test(haystack)
    || /\b\d{1,3}\s*\/\s*\d{1,4}\b/.test(haystack);
}

function resolveSearchSetName(metadata = {}, parallelValue = null) {
  const setName = String(metadata.setName || "").trim();
  const normalizedSet = normalize(setName);
  const normalizedParallel = normalize(parallelValue || metadata.parallel || "");
  const wantsChromeStyle = /(refractor|wave|holo|prizm|prism)/.test(normalizedParallel);
  if (wantsChromeStyle && /topps/.test(normalizedSet) && /ufc/.test(normalizedSet) && !/chrome/.test(normalizedSet)) {
    return setName.replace(/topps\s+ufc/i, "Topps Chrome UFC");
  }
  return setName;
}

const SET_IGNORE_WORDS = new Set([
  "basketball",
  "baseball",
  "football",
  "hockey",
  "soccer",
  "ufc",
  "trading",
  "cards",
  "card",
  "sports",
  "sport"
]);

function setFamilyTokens(value) {
  return normalize(value)
    .split(" ")
    .filter((token) => token && !SET_IGNORE_WORDS.has(token) && !/^\d+$/.test(token));
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function titleText(row) {
  return normalize(row.title);
}

function matchesCoreCardIdentity(title, metadata = {}, keyword = "") {
  const haystack = normalize([title, keyword].filter(Boolean).join(" "));
  const requiredFields = [metadata.year, metadata.playerName, metadata.cardNumber]
    .filter(Boolean)
    .map((value) => normalize(value));
  if (!requiredFields.length) return false;
  if (!requiredFields.every((field) => haystack.includes(field))) return false;
  const setTokens = setFamilyTokens(metadata.setName);
  if (metadata.parallel && parallelMatchesTitle(haystack, metadata.parallel)) return true;
  if (metadata.cardNumber && haystack.includes(normalize(metadata.cardNumber))) return true;
  return setTokens.length ? setTokens.some((token) => haystack.includes(token)) : true;
}

function buildYearFirstParts(metadata = {}, { includeParallel = true } = {}) {
  const numberingToken = numberingSearchToken(metadata);
  return [
    metadata.year,
    metadata.playerName,
    metadata.searchSetName || metadata.setName,
    metadata.cardNumber,
    includeParallel ? metadata.parallel : null,
    numberingToken,
    ...autographSearchTokens(metadata),
    ...(metadata.rookieFlag
      ? (/rated rookie/.test(normalize(metadata.variantLabel || "")) || /optic/.test(normalize(metadata.setName || ""))
        ? ["Rated Rookie", "RC"]
        : ["Rookie", "RC"])
      : [])
  ].map(cleanQueryText).filter(Boolean);
}

function rookieStyleFromMetadata(metadata = {}) {
  const setName = normalize(metadata.setName || "");
  const variantLabel = normalize(metadata.variantLabel || "");
  return /rated rookie/.test(variantLabel) || /optic/.test(setName) ? "rated" : "generic";
}

function rookieTitleMatches(title, metadata = {}) {
  if (!metadata.rookieFlag) return true;
  const haystack = normalize(title);
  const style = rookieStyleFromMetadata(metadata);
  if (style === "generic" && haystack.includes("rated rookie")) return false;
  if (style === "rated") return haystack.includes("rated rookie") || /\brc\b/.test(haystack) || haystack.includes("rookie card");
  return haystack.includes("rookie") || /\brc\b/.test(haystack);
}

function parallelMatchesTitle(title, parallel) {
  const haystack = normalize(title);
  const needle = normalize(parallel);
  if (!needle) return true;
  if (haystack.includes(needle)) return true;
  const parts = needle.split(" ").filter(Boolean);
  if (parts.length > 1 && parts.every((part) => haystack.includes(part))) return true;
  if (needle.includes("blue refractor")) {
    return haystack.includes("blue") && (haystack.includes("refractor") || haystack.includes("chrome") || haystack.includes("optic"));
  }
  if (needle.includes("blue wave")) {
    return haystack.includes("blue") && haystack.includes("wave");
  }
  if (needle.includes("silver prizm") || needle.includes("silver prism")) {
    return haystack.includes("silver") && (haystack.includes("prizm") || haystack.includes("prism"));
  }
  if (needle.includes("holo")) {
    return haystack.includes("holo") || (haystack.includes("optic") && haystack.includes("silver"));
  }
  if (needle.includes("gold")) {
    return haystack.includes("gold");
  }
  return false;
}

function inferParallelHint(metadata = {}) {
  if (metadata.baseHint) return null;
  if (metadata.parallel) return null;
  if (!(metadata.serialNumber || metadata.printRun)) return null;
  const setName = normalize(metadata.setName || "");
  if (/(chrome|refractor)/.test(setName)) return "Blue Refractor";
  if (/optic/.test(setName)) return "Holo";
  if (/select/.test(setName)) return "Blue";
  if (/prizm/.test(setName)) return "Silver Prizm";
  return null;
}

function numberingSearchToken(metadata = {}) {
  if (metadata.printRun) return `/${metadata.printRun}`;
  const serial = String(metadata.serialNumber || "");
  const serialMatch = /\b\d{1,3}\s*\/\s*(\d{1,4})\b/.exec(serial);
  if (serialMatch) return `/${serialMatch[1]}`;
  if (/^\d+$/.test(serial)) return serial;
  return null;
}

function derivedPrintRun(metadata = {}) {
  if (metadata.printRun) return metadata.printRun;
  const serial = String(metadata.serialNumber || "");
  const serialMatch = /\b\d{1,3}\s*\/\s*(\d{1,4})\b/.exec(serial);
  return serialMatch ? Number(serialMatch[1]) : null;
}

function autographSearchTokens(metadata = {}) {
  return metadata.autographFlag ? ["Autograph"] : [];
}

function autographTitleMatches(title, metadata = {}) {
  if (!metadata.autographFlag) return true;
  const haystack = normalize(title);
  return /\bautograph\b/.test(haystack)
    || /\bsignature\b/.test(haystack)
    || /\bsigned\b/.test(haystack)
    || /\bauto\b/.test(haystack);
}

function scoreListing(row, metadata = {}) {
  const title = titleText(row);
  const keyword = normalize(row.keyword);
  let score = 0;

  const fields = [
    metadata.playerName,
    metadata.year,
    metadata.setName,
    metadata.cardNumber,
    metadata.parallel,
    metadata.serialNumber
  ].filter(Boolean);

  for (const field of fields) {
    if (title.includes(normalize(field))) score += 2;
  }

  if (metadata.playerName && metadata.cardNumber && title.includes(normalize(`${metadata.playerName} ${metadata.cardNumber}`))) {
    score += 2;
  }

  if (keyword && metadata.playerName && keyword.includes(normalize(metadata.playerName))) score += 1;
  if (keyword && metadata.cardNumber && keyword.includes(normalize(metadata.cardNumber))) score += 1;

  if (metadata.rookieFlag) {
    const ratedRookieStyle = /rated rookie/.test(normalize(metadata.variantLabel || "")) || /optic/.test(normalize(metadata.setName || ""));
    if (ratedRookieStyle) {
      if (title.includes("rated rookie")) score += 3;
      if (/\brc\b/.test(title)) score += 1;
      if (title.includes("rookie card")) score += 1;
    } else {
      if (title.includes("rookie")) score += 2;
      if (/\brc\b/.test(title)) score += 2;
      if (title.includes("rookie card")) score += 1;
    }
  }

  if (metadata.variantLabel && title.includes(normalize(metadata.variantLabel))) {
    score += 2;
  }
  if (metadata.autographFlag) {
    if (/\bautograph\b/.test(title) || /\bsignature\b/.test(title) || /\bsigned\b/.test(title) || /\bauto\b/.test(title)) {
      score += 3;
    }
  }
  if (metadata.parallel && parallelMatchesTitle(row.title || "", metadata.parallel)) {
    score += 2;
  }

  if (metadata.printRun) {
    if (title.includes(`/${metadata.printRun}`) || title.includes(String(metadata.printRun))) {
      score += 2;
    }
  }

  if (row.isBestOfferAccepted) score += 1;
  if ((row.listingType || "").toLowerCase() === "buy_it_now") score += 1;

  if (/(lot|bundle|set of|team lot|3-card lot|multi-card lot)/i.test(row.title || "")) {
    score -= 4;
  }

  return score;
}

function dedupeListings(listings) {
  const seen = new Set();
  const unique = [];
  for (const listing of listings) {
    const key = listing.listingId || `${normalize(listing.title)}:${listing.totalPrice ?? listing.salePrice ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(listing);
  }
  return unique;
}

function thresholdForMetadata(metadata = {}) {
  if (metadata.serialNumber || metadata.printRun) return metadata.rookieFlag ? 6 : 7;
  if (metadata.rookieFlag) return 6;
  if (metadata.parallel) return 5;
  return 4;
}

function getApifyConfig() {
  return {
    token: process.env.APIFY_TOKEN || "",
    actorId: (process.env.APIFY_EBAY_SOLD_ACTOR_ID || "caffein.dev~ebay-sold-listings").replaceAll("/", "~"),
    daysToScrape: Number(process.env.APIFY_EBAY_SOLD_DAYS_TO_SCRAPE || 60),
    count: Number(process.env.APIFY_EBAY_SOLD_COUNT || 10),
    ebaySite: process.env.APIFY_EBAY_SITE || "ebay.com",
    sortOrder: process.env.APIFY_EBAY_SORT_ORDER || "endedRecently",
    itemLocation: process.env.APIFY_EBAY_ITEM_LOCATION || "default"
  };
}

export function hasApifyConfig() {
  return Boolean(getApifyConfig().token);
}

function buildApifyKeywords(metadata = {}) {
  const queries = [];
  const baseHint = Boolean(metadata.baseHint);
  const parallelHint = baseHint ? null : inferParallelHint(metadata);
  const searchSetName = resolveSearchSetName(metadata, baseHint ? null : (parallelHint || metadata.parallel));

  const exact = buildYearFirstParts({
    ...metadata,
    searchSetName,
    parallel: null,
    serialNumber: null,
    printRun: derivedPrintRun(metadata)
  }, { includeParallel: false }).join(" ").replace(/\s+/g, " ").trim();
  if (exact) queries.push(exact);

  if (baseHint) {
    const baseQuery = [
      metadata.year,
      metadata.playerName,
      searchSetName || metadata.setName,
      metadata.cardNumber,
      "Base"
    ]
      .map(cleanQueryText)
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (baseQuery && baseQuery !== exact) queries.push(baseQuery);
  }

  if (metadata.autographFlag) {
    const autographQuery = [
      metadata.year,
      metadata.playerName,
      searchSetName || metadata.setName,
      metadata.cardNumber,
      "Autograph"
    ]
      .map(cleanQueryText)
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (autographQuery && autographQuery !== exact) queries.push(autographQuery);

    const autoQuery = [
      metadata.year,
      metadata.playerName,
      searchSetName || metadata.setName,
      metadata.cardNumber,
      "Auto"
    ]
      .map(cleanQueryText)
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (autoQuery && autoQuery !== exact && autoQuery !== autographQuery) queries.push(autoQuery);
  }

  if (parallelHint) {
    const compactParallel = [
      metadata.year,
      metadata.playerName,
      searchSetName || metadata.setName,
      metadata.cardNumber,
      parallelHint
    ]
      .map(cleanQueryText)
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (compactParallel && compactParallel !== exact) queries.push(compactParallel);
  }

  if (metadata.rookieFlag) {
    const rookie = buildYearFirstParts({
      ...metadata,
      searchSetName,
      parallel: metadata.parallel || null
    }, { includeParallel: false }).join(" ").replace(/\s+/g, " ").trim();
    if (rookie) queries.push(rookie);
  }

  if (!baseHint && !parallelHint && metadata.parallel) {
    const compactParallel = [
      metadata.year,
      metadata.playerName,
      searchSetName || metadata.setName,
      metadata.cardNumber,
      metadata.parallel
    ]
      .map(cleanQueryText)
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (compactParallel && compactParallel !== exact) queries.push(compactParallel);
  }

  const concise = [
    metadata.year,
    metadata.playerName,
    searchSetName || metadata.setName,
    metadata.cardNumber,
    metadata.autographFlag ? "Autograph" : null,
    baseHint ? null : metadata.parallel
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  if (concise) queries.push(concise);

  return [...new Set(queries.filter(Boolean))].slice(0, 6);
}

export function buildApifyLookupKey(metadata = {}) {
  return [
    metadata.playerName || "",
    metadata.year || "",
    metadata.setName || "",
    metadata.cardNumber || "",
    metadata.parallel || "",
    metadata.serialNumber || "",
    metadata.printRun || "",
    metadata.autographFlag ? "auto" : "noauto",
    metadata.rookieFlag ? "rookie" : "raw",
    metadata.variantLabel || ""
  ].join("|");
}

export async function searchApifySoldListings(metadata = {}) {
  const config = getApifyConfig();
  if (!config.token) {
    throw new Error("Missing APIFY_TOKEN");
  }

  const keywords = buildApifyKeywords(metadata);
  if (!keywords.length) {
    return { comps: [], importedCount: 0, rejectedCount: 0, sampleTitles: [] };
  }

  const parsedRuns = [];
  const queryLimit = Math.min(keywords.length, (metadata.baseHint || metadata.parallel || inferParallelHint(metadata) || metadata.autographFlag) ? 2 : 1);
  const keywordsUsed = keywords.slice(0, queryLimit);

  for (const keyword of keywordsUsed) {
    const input = {
      keywords: [keyword],
      daysToScrape: config.daysToScrape,
      count: config.count,
      ebaySite: config.ebaySite,
      sortOrder: config.sortOrder,
      itemLocation: config.itemLocation,
      itemCondition: metadata.gradedFlag ? "any" : "used"
    };

    const response = await fetch(`https://api.apify.com/v2/acts/${config.actorId}/run-sync-get-dataset-items?token=${encodeURIComponent(config.token)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(input)
    });

    const payload = await response.json();
    if (!response.ok) {
      const message = payload?.error?.message || payload?.message || payload?.error || `HTTP ${response.status}`;
      throw new Error(`Apify sold listings request failed (${response.status}): ${message}`);
    }

    const items = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : [];
    const queryParallel = keyword.includes("Blue Refractor")
      ? "Blue Refractor"
      : keyword.includes("Holo")
        ? "Holo"
        : keyword.includes("Blue")
          ? "Blue"
          : keyword.includes("Silver Prizm")
            ? "Silver Prizm"
            : null;
    const parsed = parseApifySoldListings(items, {
      ...metadata,
      baseHint: metadata.baseHint,
      parallel: queryParallel
    });
    parsedRuns.push(parsed);
  }

  const comps = dedupeListings(parsedRuns.flatMap((entry) => entry.comps))
    .sort((a, b) => b.matchScore - a.matchScore || a.totalPrice - b.totalPrice);
  const limit = Math.max(1, Math.min(config.count, 10));
  const rejectedCount = parsedRuns.reduce((sum, entry) => sum + (entry.rejectedCount || 0), 0);
  return {
    comps: comps.slice(0, limit),
    importedCount: Math.min(comps.length, limit),
    rejectedCount,
    sampleTitles: comps.slice(0, 5).map((comp) => comp.title),
    keywordsUsed
  };
}

function normalizeSoldListing(row, metadata = {}) {
  const title = row.title || row.keyword || "";
  if (!rookieTitleMatches(title, metadata)) {
    return null;
  }
  if (!matchesCoreCardIdentity(title, metadata, row.keyword || "")) {
    return null;
  }
  if (metadata.baseHint && hasExplicitVariantSignals(row.title || "")) {
    return null;
  }
  if (!autographTitleMatches(row.title || row.keyword || "", metadata)) {
    return null;
  }
  if (metadata.parallel && !parallelMatchesTitle(row.title || row.keyword || "", metadata.parallel)) {
    return null;
  }
  const salePrice = toNumber(row.soldPrice);
  const shippingPrice = toNumber(row.shippingPrice);
  const totalPrice = toNumber(row.totalPrice) ?? (salePrice == null ? null : salePrice + (shippingPrice || 0));
  const score = scoreListing(row, metadata);
  if (score < thresholdForMetadata(metadata)) {
    return null;
  }

  return {
    source: "apify_sold_listings",
    listingId: String(row.itemId || row.url || `${row.title || "listing"}:${row.endedAt || row.scrapedAt || ""}`),
    title: row.title || row.keyword || "Unknown listing",
    conditionLabel: row.condition || null,
    salePrice,
    shippingPrice,
    totalPrice,
    soldAt: row.endedAt || row.soldAt || null,
    url: row.url || null,
    matchScore: Number((Math.min(score, 12) / 12).toFixed(2)),
    listingType: row.listingType || null,
    isBestOfferAccepted: Boolean(row.isBestOfferAccepted),
    sellerUsername: row.sellerUsername || null,
    sellerPositivePercent: row.sellerPositivePercent ?? null,
    sellerFeedbackScore: row.sellerFeedbackScore ?? null,
    scrapedAt: row.scrapedAt || nowIso(),
    rawPayload: row
  };
}

export function parseApifySoldListings(input, metadata = {}) {
  const rows = Array.isArray(input)
    ? input
    : Array.isArray(input?.results)
      ? input.results
      : Array.isArray(input?.items)
        ? input.items
        : Array.isArray(input?.records)
          ? input.records
          : [];

  const comps = [];
  const rejected = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const normalized = normalizeSoldListing(row, metadata);
    if (normalized) {
      comps.push(normalized);
    } else {
      rejected.push(row);
    }
  }

  comps.sort((a, b) => (b.soldAt || "").localeCompare(a.soldAt || "") || a.totalPrice - b.totalPrice);

  return {
    comps,
    importedCount: comps.length,
    rejectedCount: rejected.length,
    sampleTitles: comps.slice(0, 5).map((comp) => comp.title)
  };
}
