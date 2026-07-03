import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalize,
  cleanQueryText,
  hasExplicitVariantSignals,
  resolveSearchSetName,
  setFamilyTokens,
  parsePrintRunFromSerial,
  inferParallelHint,
  numberingSearchToken,
  derivedPrintRun,
  rookieSearchTokens,
  autographSearchTokens,
  autographTitleMatches,
  rookieStyleFromMetadata,
  rookieTitleMatches,
  parallelMatchesTitle,
  buildYearFirstParts,
} from "../lib/card-query.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const browseCachePath = path.join(rootDir, "data", "ebay-browse-cache.json");
let browseCache = null;

function getConfig() {
  const environment = process.env.EBAY_ENV === "sandbox" ? "sandbox" : "production";
  const baseUrl =
    environment === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
  return {
    environment,
    baseUrl,
    clientId: process.env.EBAY_CLIENT_ID || "",
    clientSecret: process.env.EBAY_CLIENT_SECRET || "",
    marketplaceId: process.env.EBAY_MARKETPLACE_ID || "EBAY_US",
    categoryId: process.env.EBAY_CATEGORY_ID || "261328",
    tradingCardGameCategoryId: process.env.EBAY_TCG_CATEGORY_ID || "183454",
    nonSportTradingCardCategoryId: process.env.EBAY_NONSPORT_TRADING_CARD_CATEGORY_ID || "183050",
  };
}

async function loadBrowseCache() {
  if (browseCache) return browseCache;
  try {
    const raw = await fs.readFile(browseCachePath, "utf8");
    browseCache = JSON.parse(raw);
  } catch {
    browseCache = {};
  }
  return browseCache;
}

async function saveBrowseCache() {
  if (!browseCache) return;
  await fs.mkdir(path.dirname(browseCachePath), { recursive: true });
  await fs.writeFile(browseCachePath, JSON.stringify(browseCache, null, 2));
}

let tokenCache = null;

function isAmbiguousChoiceTitle(value) {
  const title = String(value || "");
  return (
    /\b(?:pick your card|you pick|choose your card|select your card|choose one|you choose)\b/i.test(
      title,
    ) ||
    /\b(?:complete|finish)\s+your\b.{0,35}\bset\b/i.test(title) ||
    /\brookies?\s*(?:&|\+|and|n)?\s*more\b/i.test(title) ||
    /\b(?:vets?|veterans?)\s*(?:&|\+|and|n)\s*(?:rookies?|stars?)\b/i.test(title)
  );
}

function cleanSoldQueryTitle(value) {
  return cleanQueryText(value)
    .replace(/\b(?:read|look|wow|hot|mint|near mint|nm|lp)\b/gi, " ")
    .replace(/\b(?:pick your card|you pick|choose your card|select your card|choose one|you choose)\b/gi, " ")
    .replace(/\b(?:complete|finish)\s+your\b.{0,35}\bset\b/gi, " ")
    .replace(/\brookies?\s*(?:&|\+|and|n)?\s*more\b/gi, " ")
    .replace(/\b(?:vets?|veterans?)\s*(?:&|\+|and|n)\s*(?:rookies?|stars?)\b/gi, " ")
    .replace(/[^\w\s#./'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function soldQueryVariantsFromTitle(title) {
  if (!title || isAmbiguousChoiceTitle(title)) return [];
  const cleaned = cleanSoldQueryTitle(title);
  if (!cleaned) return [];
  const queries = [cleaned];
  const noSerial = cleaned.replace(/\b\d{1,4}\s*\/\s*\d{1,5}\b/g, " ").replace(/\s+/g, " ").trim();
  if (noSerial && noSerial !== cleaned) queries.push(noSerial);
  return [...new Set(queries)].slice(0, 2);
}

function titleHintQuery(metadata = {}) {
  return cleanQueryText(metadata.titleHint || metadata.ebayTitle || metadata.title || "")
    .replace(/\s+/g, " ")
    .trim();
}

const TITLE_HINT_IGNORE_WORDS = new Set([
  "card",
  "cards",
  "the",
  "and",
  "with",
  "for",
  "panini",
  "topps",
  "upper",
  "deck",
]);

function titleHintTokens(value) {
  return normalize(value)
    .split(" ")
    .filter((token) => token.length >= 2 && !TITLE_HINT_IGNORE_WORDS.has(token));
}

function titleHintMatchesResult(title, metadata = {}) {
  const hintTokens = titleHintTokens(titleHintQuery(metadata));
  if (!hintTokens.length) return false;
  const titleTokens = new Set(titleHintTokens(title));
  if (!titleTokens.size) return false;
  const overlap = hintTokens.filter((token) => titleTokens.has(token)).length;
  const needed = Math.min(5, Math.max(2, Math.ceil(hintTokens.length * 0.35)));
  return overlap >= needed;
}

function shouldAllowImageOnlyMatches(metadata = {}) {
  return Boolean(metadata.allowImageOnlyMatches) && !titleHintQuery(metadata);
}

function matchesCoreCardIdentity(title, metadata = {}) {
  const haystack = normalize(title);
  const requiredFields = [metadata.year, metadata.playerName, metadata.cardNumber]
    .filter(Boolean)
    .map((value) => normalize(value));
  if (!requiredFields.length) {
    return shouldAllowImageOnlyMatches(metadata) || titleHintMatchesResult(title, metadata);
  }
  if (!requiredFields.every((field) => haystack.includes(field))) return false;
  const setTokens = setFamilyTokens(metadata.setName);
  return setTokens.length ? setTokens.some((token) => haystack.includes(token)) : true;
}

function scoreTitle(title, metadata) {
  const haystack = normalize(title);
  let score = 0;
  const fields = [
    metadata.playerName,
    metadata.year,
    metadata.setName,
    metadata.cardNumber,
    metadata.parallel,
    metadata.serialNumber,
  ].filter(Boolean);
  for (const field of fields) {
    if (haystack.includes(normalize(field))) score += 2;
  }
  if (metadata.parallel) {
    const parallelParts = normalize(metadata.parallel).split(" ").filter(Boolean);
    if (parallelParts.every((part) => haystack.includes(part))) score += 3;
  }
  if (
    metadata.serialNumber &&
    /\/\d+/.test(String(metadata.serialNumber)) &&
    haystack.includes(normalize(metadata.serialNumber))
  ) {
    score += 2;
  }
  if (metadata.printRun && haystack.includes(String(metadata.printRun))) {
    score += 2;
  }
  if (metadata.rookieFlag) {
    const ratedRookieStyle = rookieStyleFromMetadata(metadata) === "rated";
    if (ratedRookieStyle) {
      if (haystack.includes("rated rookie")) score += 3;
      if (/\brc\b/.test(haystack)) score += 1;
    } else {
      if (haystack.includes("rookie")) score += 2;
      if (/\brc\b/.test(haystack)) score += 2;
    }
  }
  if (metadata.variantLabel && haystack.includes(normalize(metadata.variantLabel))) {
    score += 2;
  }
  if (
    metadata.autographFlag &&
    (haystack.includes("autograph") ||
      haystack.includes("signature") ||
      haystack.includes("signed") ||
      haystack.includes("auto"))
  ) {
    score += 3;
  }
  if (metadata.parallel && parallelMatchesTitle(title, metadata.parallel)) {
    score += 2;
  }
  if (metadata.playerName && metadata.cardNumber && metadata.year) {
    const exact = [metadata.playerName, metadata.year, metadata.cardNumber].every((field) =>
      haystack.includes(normalize(field)),
    );
    if (exact) score += 2;
  }
  return score;
}

async function request(
  pathname,
  { method = "GET", body, contentType = "application/json", marketplaceId } = {},
) {
  const config = getConfig();
  const url = new URL(`${config.baseUrl}${pathname}`);
  const headers = {
    Authorization: `Bearer ${await getApplicationToken()}`,
    Accept: "application/json",
  };
  if (marketplaceId) {
    headers["X-EBAY-C-MARKETPLACE-ID"] = marketplaceId;
  }
  if (body !== undefined) {
    headers["Content-Type"] = contentType;
  }

  const response = await fetch(url, {
    method,
    headers,
    body:
      body === undefined
        ? undefined
        : contentType === "application/json"
          ? JSON.stringify(body)
          : body,
  });
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    const message =
      payload?.errors?.[0]?.message || payload?.message || text || `HTTP ${response.status}`;
    throw new Error(`eBay ${method} ${pathname} failed (${response.status}): ${message}`);
  }

  return payload;
}

async function getApplicationToken() {
  const config = getConfig();
  if (!config.clientId || !config.clientSecret) {
    throw new Error("Missing EBAY_CLIENT_ID or EBAY_CLIENT_SECRET");
  }
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }

  const auth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "https://api.ebay.com/oauth/api_scope",
  });
  const response = await fetch(`${config.baseUrl}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const payload = await response.json();
  if (!response.ok) {
    const message = payload?.error_description || payload?.message || `HTTP ${response.status}`;
    throw new Error(`eBay application token request failed (${response.status}): ${message}`);
  }

  tokenCache = {
    token: payload.access_token,
    expiresAt: Date.now() + Number(payload.expires_in || 0) * 1000,
  };
  return tokenCache.token;
}

function readFileAsBase64(filePath) {
  return fs.readFile(filePath).then((bytes) => bytes.toString("base64"));
}

async function readImageUrlAsBase64(imageUrl) {
  const normalized = String(imageUrl || "").trim();
  if (!/^https?:\/\//i.test(normalized)) return null;
  const response = await fetch(normalized, {
    headers: {
      Accept: "image/*",
    },
  });
  if (!response.ok) {
    throw new Error(`Image download failed (${response.status}).`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return bytes.length ? bytes.toString("base64") : null;
}

function buildKeywordQuery(metadata) {
  const parts = buildYearFirstParts(metadata);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function buildKeywordQueries(metadata) {
  const queries = [];
  const fallbackTitleQuery = titleHintQuery(metadata);
  const baseHint = Boolean(metadata.baseHint);
  const parallelHint = baseHint ? null : inferParallelHint(metadata);
  const searchSetName = resolveSearchSetName(
    metadata,
    baseHint ? null : parallelHint || metadata.parallel,
  );
  const exact = buildKeywordQuery({
    ...metadata,
    searchSetName,
    serialNumber: null,
    printRun: derivedPrintRun(metadata),
  });
  if (exact) queries.push(exact);

  if (baseHint) {
    const baseQuery = [
      metadata.year,
      metadata.playerName,
      searchSetName || metadata.setName,
      metadata.cardNumber,
      "Base",
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
      "Autograph",
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
      "Auto",
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
      parallelHint,
    ]
      .map(cleanQueryText)
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (compactParallel && compactParallel !== exact) queries.push(compactParallel);
  }

  if (metadata.rookieFlag) {
    const rookieParts = buildYearFirstParts(
      {
        ...metadata,
        searchSetName,
        parallel: metadata.parallel || null,
      },
      { includeParallel: false },
    );
    queries.push(rookieParts.join(" ").replace(/\s+/g, " ").trim());
  }

  if (!baseHint && !parallelHint && metadata.parallel) {
    const compactParallel = [
      metadata.year,
      metadata.playerName,
      searchSetName || metadata.setName,
      metadata.cardNumber,
      metadata.parallel,
    ]
      .map(cleanQueryText)
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (compactParallel && compactParallel !== exact) queries.push(compactParallel);
  }

  const conciseParts = [
    metadata.year,
    metadata.playerName,
    searchSetName || metadata.setName,
    metadata.cardNumber,
    ...rookieSearchTokens(metadata),
    baseHint ? null : metadata.parallel,
  ].filter(Boolean);
  if (conciseParts.length >= 3) {
    queries.push(conciseParts.join(" ").replace(/\s+/g, " ").trim());
  }

  if (!queries.length && fallbackTitleQuery) queries.push(fallbackTitleQuery);

  return [...new Set(queries.filter(Boolean))];
}

function toBrowseItemSummary(item, metadata, extra = {}) {
  const price = Number(item.price?.value ?? item.price ?? 0);
  const shippingPrice = Number(item.shippingOptions?.[0]?.shippingCost?.value ?? 0);
  const totalPrice = price + shippingPrice;
  return {
    source: "browse_active",
    kind: "active",
    ...extra,
    listingId: item.itemId,
    title: item.title,
    conditionLabel: item.condition,
    salePrice: null,
    shippingPrice,
    totalPrice,
    price,
    soldAt: null,
    url: item.itemWebUrl || item.itemGroupHref || null,
    matchScore: scoreTitle(item.title, metadata),
  };
}

function dedupeListings(listings) {
  const seen = new Set();
  const unique = [];
  for (const listing of listings) {
    const key = listing.listingId || `${normalize(listing.title)}:${listing.totalPrice}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(listing);
  }
  return unique;
}

function minScoreForMetadata(metadata) {
  if (shouldAllowImageOnlyMatches(metadata)) return 0;
  if (![metadata.year, metadata.playerName, metadata.cardNumber].filter(Boolean).length && titleHintQuery(metadata)) {
    return 0;
  }
  if (metadata.serialNumber || metadata.printRun) return metadata.rookieFlag ? 6 : 7;
  if (metadata.rookieFlag) return 5;
  if (metadata.parallel) return 5;
  return 4;
}

function resolveBrowseCategoryId(metadata = {}) {
  const config = getConfig();
  const haystack = normalize([
    metadata.sport,
    metadata.candidateSport,
    metadata.setName,
    metadata.titleHint,
    metadata.playerName,
    metadata.ebayTitle,
    metadata.title,
    metadata.notes,
  ]
    .filter(Boolean)
    .join(" "));
  if (!haystack) return config.categoryId;
  if (/\b(wwe|wwf|wrestling|aew|wcw|ufc|mma|mixed martial)\b/.test(haystack)) {
    return config.categoryId;
  }
  if (/\b(pokemon|pok[eé]mon|magic|mtg|yugioh|yu gi oh|lorcana|one piece|digimon)\b/.test(haystack)) {
    return config.tradingCardGameCategoryId || null;
  }
  if (/\b(star wars|marvel|dc|garbage pail|non sport|non-sport|trading cards)\b/.test(haystack)) {
    return config.nonSportTradingCardCategoryId || null;
  }
  return config.categoryId;
}

function buildFindingCompletedItemsUrl(keywords, limit, categoryId = null) {
  const config = getConfig();
  const url = new URL("https://svcs.ebay.com/services/search/FindingService/v1");
  url.searchParams.set("OPERATION-NAME", "findCompletedItems");
  url.searchParams.set("SERVICE-VERSION", "1.13.0");
  url.searchParams.set("SECURITY-APPNAME", config.clientId);
  url.searchParams.set("RESPONSE-DATA-FORMAT", "JSON");
  url.searchParams.set("REST-PAYLOAD", "true");
  url.searchParams.set("GLOBAL-ID", "EBAY-US");
  url.searchParams.set("keywords", keywords);
  if (categoryId) url.searchParams.set("categoryId", categoryId);
  url.searchParams.set("paginationInput.entriesPerPage", String(limit));
  url.searchParams.set("sortOrder", "EndTimeSoonest");
  url.searchParams.set("itemFilter(0).name", "SoldItemsOnly");
  url.searchParams.set("itemFilter(0).value", "true");
  return url;
}

async function findingRequest(keywords, limit, categoryId = null) {
  const config = getConfig();
  if (!config.clientId) {
    throw new Error("Missing EBAY_CLIENT_ID");
  }

  const url = buildFindingCompletedItemsUrl(keywords, limit, categoryId);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`eBay Finding API request failed (${response.status}).`);
  }
  return payload;
}

function isTradingCardBrowseCategory(categoryId) {
  const raw = String(categoryId || "").trim();
  const config = getConfig();
  return Boolean(
    raw &&
      (raw === String(config.tradingCardGameCategoryId || "").trim() ||
        raw === String(config.nonSportTradingCardCategoryId || "").trim()),
  );
}

function firstArrayValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function moneyValue(node) {
  if (!node) return 0;
  const raw = firstArrayValue(node);
  const value = Number(raw?.__value__ ?? raw?.value ?? raw ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function toBrowseSoldItem(item, metadata) {
  const title = firstArrayValue(item?.title) || "";
  const salePrice = moneyValue(item?.sellingStatus?.[0]?.currentPrice);
  const shippingPrice = moneyValue(item?.shippingInfo?.[0]?.shippingServiceCost);
  return {
    source: "browse_sold",
    kind: "sold",
    listingId: firstArrayValue(item?.itemId) || null,
    title,
    conditionLabel: firstArrayValue(item?.condition?.[0]?.conditionDisplayName) || null,
    salePrice,
    shippingPrice,
    totalPrice: salePrice + shippingPrice,
    price: salePrice,
    soldAt: firstArrayValue(item?.listingInfo?.[0]?.endTime) || null,
    url: firstArrayValue(item?.viewItemURL) || null,
    matchScore: scoreTitle(title, metadata),
  };
}

function buildSoldCompQueries(metadata = {}, matchedListings = []) {
  const queries = [];
  const matchLimit = metadata.fastMode ? 6 : 10;
  for (const listing of matchedListings
    .filter((entry) => entry?.title && !isAmbiguousChoiceTitle(entry.title))
    .slice(0, matchLimit)) {
    queries.push(...soldQueryVariantsFromTitle(listing?.title || ""));
  }
  queries.push(...buildKeywordQueries(metadata));
  return [...new Set(queries.filter(Boolean))];
}

export async function searchEbayListings({
  metadata = {},
  frontImagePath = null,
  backImagePath = null,
  imageUrl = null,
} = {}) {
  const resultLimit = Math.max(
    metadata.fastMode ? 15 : 1,
    Math.min(Number(process.env.EBAY_BROWSE_ACTIVE_COUNT || 50), metadata.fastMode ? 25 : 50),
  );
  const categoryId = resolveBrowseCategoryId(metadata);
  const searches = [];
  const keywordQueries = buildKeywordQueries(metadata);
  for (const keywordQuery of keywordQueries) {
    const searchUrl = new URL("/buy/browse/v1/item_summary/search", getConfig().baseUrl);
    searchUrl.searchParams.set("q", keywordQuery);
    if (categoryId) searchUrl.searchParams.set("category_ids", categoryId);
    searchUrl.searchParams.set("limit", String(resultLimit));
    searchUrl.searchParams.set("sort", "price");
    const conditionFilter = metadata.gradedFlag ? "conditionIds:{2750}" : "conditionIds:{4000}";
    searchUrl.searchParams.set(
      "filter",
      `buyingOptions:{FIXED_PRICE},itemLocationCountry:US,${conditionFilter}`,
    );
    searches.push(
      request(`${searchUrl.pathname}?${searchUrl.searchParams.toString()}`, {
        marketplaceId: getConfig().marketplaceId,
      }).then((payload) =>
        (payload.itemSummaries || []).map((item) => toBrowseItemSummary(item, metadata)),
      ),
    );
  }

  if (frontImagePath) {
    searches.push(
      readFileAsBase64(frontImagePath).then((image) =>
        request(`/buy/browse/v1/item_summary/search_by_image?limit=${resultLimit}`, {
          method: "POST",
          body: { image },
          marketplaceId: getConfig().marketplaceId,
        }).then((payload) =>
          (payload.itemSummaries || []).map((item, index) =>
            toBrowseItemSummary(item, metadata, { imageRank: index, matchSource: "image" }),
          ),
        ),
      ),
    );
  }

  if (backImagePath) {
    searches.push(
      readFileAsBase64(backImagePath).then((image) =>
        request(`/buy/browse/v1/item_summary/search_by_image?limit=${resultLimit}`, {
          method: "POST",
          body: { image },
          marketplaceId: getConfig().marketplaceId,
        }).then((payload) =>
          (payload.itemSummaries || []).map((item, index) =>
            toBrowseItemSummary(item, metadata, { imageRank: index, matchSource: "image" }),
          ),
        ),
      ),
    );
  }

  if (imageUrl) {
    searches.push(
      readImageUrlAsBase64(imageUrl).then((image) =>
        image
          ? request(`/buy/browse/v1/item_summary/search_by_image?limit=${resultLimit}`, {
              method: "POST",
              body: { image },
              marketplaceId: getConfig().marketplaceId,
            }).then((payload) =>
              (payload.itemSummaries || []).map((item, index) =>
                toBrowseItemSummary(item, metadata, { imageRank: index, matchSource: "image" }),
              ),
            )
          : [],
      ),
    );
  }

  const results = await Promise.allSettled(searches);
  const listings = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  const listingKey = (listing) =>
    listing.listingId ||
    listing.itemId ||
    listing.url ||
    `${normalize(listing.title)}:${listing.totalPrice}`;
  const sortActiveListings = (a, b) => {
    if (shouldAllowImageOnlyMatches(metadata)) {
      const aRank = Number.isFinite(a.imageRank) ? a.imageRank : Number.POSITIVE_INFINITY;
      const bRank = Number.isFinite(b.imageRank) ? b.imageRank : Number.POSITIVE_INFINITY;
      if (aRank !== bRank) return aRank - bRank;
    }
    return b.matchScore - a.matchScore || a.totalPrice - b.totalPrice;
  };
  const rawListings = dedupeListings(listings)
    .filter((listing) => listing.totalPrice > 0)
    .filter((listing) => !isAmbiguousChoiceTitle(listing.title));
  const strictListings = rawListings
    .filter((listing) => matchesCoreCardIdentity(listing.title, metadata))
    .filter((listing) => rookieTitleMatches(listing.title, metadata))
    .filter((listing) => autographTitleMatches(listing.title, metadata))
    .filter(
      (listing) => !metadata.parallel || parallelMatchesTitle(listing.title, metadata.parallel),
    )
    .filter((listing) => !metadata.baseHint || !hasExplicitVariantSignals(listing.title))
    .filter((listing) => listing.matchScore >= minScoreForMetadata(metadata))
    .sort(sortActiveListings);
  if (metadata.fastMode && strictListings.length < 15) {
    const seen = new Set(strictListings.map(listingKey));
    const fillers = rawListings
      .filter((listing) => !seen.has(listingKey(listing)))
      .sort(sortActiveListings)
      .slice(0, resultLimit - strictListings.length);
    return [...strictListings, ...fillers].slice(0, resultLimit);
  }
  return strictListings.slice(0, resultLimit);
}

export async function searchEbaySoldListings({
  metadata = {},
  frontImagePath = null,
  backImagePath = null,
  imageUrl = null,
  matchedListings = [],
} = {}) {
  const resultLimit = Math.max(
    metadata.fastMode ? 15 : 1,
    Math.min(Number(process.env.EBAY_BROWSE_SOLD_COUNT || 50), metadata.fastMode ? 25 : 50),
  );
  const activeMatches = Array.isArray(matchedListings) && matchedListings.length
    ? matchedListings
    : await searchEbayListings({ metadata, frontImagePath, backImagePath, imageUrl });
  const queries = buildSoldCompQueries(metadata, activeMatches);
  if (!queries.length) return [];
  const categoryId = resolveBrowseCategoryId(metadata);
  const categoryVariants = isTradingCardBrowseCategory(categoryId) ? [categoryId, null] : [categoryId];

  const settled = await Promise.allSettled(
    queries.flatMap((query) =>
      categoryVariants.map(async (categoryVariant) => {
        const payload = await findingRequest(query, resultLimit, categoryVariant);
        const items =
          payload?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];
        return (Array.isArray(items) ? items : []).map((item) => toBrowseSoldItem(item, metadata));
      }),
    ),
  );

  const soldListingKey = (listing) =>
    listing.listingId ||
    listing.itemId ||
    listing.url ||
    `${normalize(listing.title)}:${listing.totalPrice}`;
  const sortSoldListings = (a, b) =>
    b.matchScore - a.matchScore ||
    String(b.soldAt || "").localeCompare(String(a.soldAt || "")) ||
    a.totalPrice - b.totalPrice;
  const rawSoldListings = dedupeListings(
    settled.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
  )
    .filter((listing) => listing.totalPrice > 0)
    .filter((listing) => !isAmbiguousChoiceTitle(listing.title));
  const strictSoldListings = rawSoldListings
    .filter((listing) => matchesCoreCardIdentity(listing.title, metadata))
    .filter((listing) => rookieTitleMatches(listing.title, metadata))
    .filter((listing) => autographTitleMatches(listing.title, metadata))
    .filter(
      (listing) => !metadata.parallel || parallelMatchesTitle(listing.title, metadata.parallel),
    )
    .filter((listing) => !metadata.baseHint || !hasExplicitVariantSignals(listing.title))
    .filter((listing) => listing.matchScore >= minScoreForMetadata(metadata))
    .sort(sortSoldListings);
  if (metadata.fastMode && strictSoldListings.length < 15) {
    const seen = new Set(strictSoldListings.map(soldListingKey));
    const fillers = rawSoldListings
      .filter((listing) => !seen.has(soldListingKey(listing)))
      .sort(sortSoldListings)
      .slice(0, resultLimit - strictSoldListings.length);
    return [...strictSoldListings, ...fillers].slice(0, resultLimit);
  }
  return strictSoldListings.slice(0, resultLimit);
}

export function hasBrowseConfig() {
  const config = getConfig();
  return Boolean(config.clientId && config.clientSecret);
}

function normalizeLegacyItemId(value) {
  const raw = String(value || "").trim();
  return /^\d+$/.test(raw) ? raw : null;
}

function extractBrowseListedAt(payload = {}) {
  return (
    payload.itemCreationDate ||
    payload.itemCreationDateTime ||
    payload.itemOriginDate ||
    payload.itemStartDate ||
    payload.listingStartDate ||
    null
  );
}

function normalizeBrowseImageUrls(...values) {
  const urls = [];
  const push = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const entry of value) push(entry);
      return;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) urls.push(trimmed);
      return;
    }
    if (typeof value === "object") {
      push(value.imageUrl);
      push(value.href);
    }
  };
  for (const value of values) push(value);
  return [...new Set(urls)];
}

function extractBrowseImageData(payload = {}) {
  const imageUrls = normalizeBrowseImageUrls(
    payload.image,
    payload.additionalImages,
    payload.thumbnailImages,
    payload.image?.additionalImages,
  );
  return {
    imageUrl: imageUrls[0] || null,
    imageUrls,
  };
}

function extractBrowseSport(payload = {}) {
  const aspectSport = Array.isArray(payload.localizedAspects)
    ? payload.localizedAspects.find((aspect) => normalize(aspect?.name) === "sport")?.value
    : null;
  const aspectLeague = Array.isArray(payload.localizedAspects)
    ? payload.localizedAspects.find((aspect) => normalize(aspect?.name) === "league")?.value
    : null;
  const haystack = normalize([
    aspectSport,
    aspectLeague,
    payload.title,
    payload.subtitle,
    payload.shortDescription,
    payload.description,
    payload.categoryPath,
    ...(Array.isArray(payload.categories)
      ? payload.categories.map((category) => category?.categoryName || category?.name || "")
      : []),
    ...(Array.isArray(payload.localizedAspects)
      ? payload.localizedAspects.flatMap((aspect) => [aspect?.name || "", aspect?.value || ""])
      : []),
  ].filter(Boolean).join(" "));
  if (!haystack) return null;
  if (/\b(basketball|nba|hoops)\b/.test(haystack)) return "Basketball";
  if (/\b(football|nfl|gridiron)\b/.test(haystack)) return "Football";
  if (/\b(baseball|mlb|bowman)\b/.test(haystack)) return "Baseball";
  if (/\b(soccer|fifa|uefa|premier league|mls|serie a|la liga|bundesliga)\b/.test(haystack)) {
    return "Soccer";
  }
  if (/\b(hockey|nhl|upper deck hockey|o pee chee|opc)\b/.test(haystack)) return "Hockey";
  if (/\b(ufc|mma|mixed martial)\b/.test(haystack)) return "MMA";
  if (
    /\b(trading card|non sport|non-sport|pokemon|magic|mtg|yugioh|yu gi oh|star wars|lorcana|one piece|digimon)\b/.test(
      haystack,
    )
  ) {
    return "Trading Cards";
  }
  return null;
}

function extractHtmlSport(html = "") {
  const raw = String(html || "");
  if (!raw) return null;
  const sportPatterns = [
    { sport: "Basketball", regexes: [/Sport\s*Basketball/i, /Sport[^A-Za-z]{0,40}Basketball/i, /National Basketball Association|\bNBA\b/i] },
    { sport: "Baseball", regexes: [/Sport\s*Baseball/i, /Sport[^A-Za-z]{0,40}Baseball/i, /Major League Baseball|\bMLB\b/i] },
    { sport: "Football", regexes: [/Sport\s*Football/i, /Sport[^A-Za-z]{0,40}Football/i, /National Football League|\bNFL\b/i] },
    { sport: "Soccer", regexes: [/Sport\s*Soccer/i, /Sport[^A-Za-z]{0,40}Soccer/i, /FIFA|UEFA|Premier League|Bundesliga|La Liga|Serie A|MLS/i] },
    { sport: "Hockey", regexes: [/Sport\s*Hockey/i, /Sport[^A-Za-z]{0,40}Hockey/i, /National Hockey League|\bNHL\b/i] },
    { sport: "MMA", regexes: [/Sport\s*UFC/i, /Sport[^A-Za-z]{0,40}UFC/i, /\bUFC\b|Mixed Martial Arts|\bMMA\b/i] },
    { sport: "Trading Cards", regexes: [/Non-?Sport Trading Card/i, /Trading Card Game/i, /Pok[eé]mon/i, /\bMagic\b|\bMTG\b/i, /Yu-?Gi-?Oh/i, /Star Wars/i, /Lorcana/i, /One Piece/i, /Digimon/i] },
  ];
  for (const candidate of sportPatterns) {
    if (candidate.regexes.some((regex) => regex.test(raw))) return candidate.sport;
  }
  return null;
}

const EBAY_MONTH_INDEX = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

const EBAY_TZ_OFFSETS = {
  PDT: -7,
  PST: -8,
  MDT: -6,
  MST: -7,
  CDT: -5,
  CST: -6,
  EDT: -4,
  EST: -5,
  GMT: 0,
  UTC: 0,
};

function parseEbayHumanListedAt(value) {
  const raw = String(value || "").trim();
  const match = raw.match(
    /\b([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)\s+([A-Z]{3})\b/,
  );
  if (!match) return null;

  const [, monthLabel, dayText, yearText, hourText, minuteText, meridiem, zone] = match;
  const monthIndex = EBAY_MONTH_INDEX[monthLabel.toLowerCase()];
  const zoneOffset = EBAY_TZ_OFFSETS[zone];
  if (monthIndex == null || zoneOffset == null) return null;

  let hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (meridiem.toLowerCase() === "pm" && hour < 12) hour += 12;
  if (meridiem.toLowerCase() === "am" && hour === 12) hour = 0;

  const utcMs = Date.UTC(
    Number(yearText),
    monthIndex,
    Number(dayText),
    hour - zoneOffset,
    minute,
    0,
    0,
  );
  const parsed = new Date(utcMs);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function fetchListingPageListedAt(legacyItemId) {
  const response = await fetch(`https://www.ebay.com/itm/${legacyItemId}`, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    },
  });
  if (!response.ok) return null;
  const html = await response.text();
  const directMatch = html.match(
    /\b([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4}\s+at\s+\d{1,2}:\d{2}\s*(?:am|pm)\s+[A-Z]{3})\b/,
  );
  if (directMatch?.[1]) {
    return parseEbayHumanListedAt(directMatch[1]);
  }

  const startedMatch = html.match(
    /Started(?:\s+on)?[^A-Za-z0-9]{0,20}([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4}\s+at\s+\d{1,2}:\d{2}\s*(?:am|pm)\s+[A-Z]{3})/i,
  );
  if (startedMatch?.[1]) {
    return parseEbayHumanListedAt(startedMatch[1]);
  }

  return null;
}

async function fetchListingPageImageData(legacyItemId) {
  const response = await fetch(`https://www.ebay.com/itm/${legacyItemId}`, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    },
  });
  if (!response.ok) return { imageUrl: null, imageUrls: [], sport: null };
  const html = await response.text();
  const imageUrls = normalizeBrowseImageUrls(
    [...html.matchAll(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/gi)].map(
      (match) => match?.[1] || "",
    ),
    [...html.matchAll(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/gi)].map(
      (match) => match?.[1] || "",
    ),
  );
  return {
    imageUrl: imageUrls[0] || null,
    imageUrls,
    sport: extractHtmlSport(html),
  };
}

export async function fetchBrowseListingDatesByLegacyId(legacyItemIds = []) {
  const ids = [...new Set((Array.isArray(legacyItemIds) ? legacyItemIds : [])
    .map(normalizeLegacyItemId)
    .filter(Boolean))];
  if (!ids.length) return {};

  const cache = await loadBrowseCache();
  const result = {};
  const pending = [];
  for (const id of ids) {
    const cached = cache[id];
    if (cached && Object.prototype.hasOwnProperty.call(cached, "listedAt")) {
      result[id] = cached.listedAt || null;
    } else {
      pending.push(id);
    }
  }

  if (!pending.length) return result;

  const concurrency = 8;
  for (let index = 0; index < pending.length; index += concurrency) {
    const batch = pending.slice(index, index + concurrency);
    const settled = await Promise.allSettled(
      batch.map(async (id) => {
        const payload = await request(
          `/buy/browse/v1/item/get_item_by_legacy_id?${new URLSearchParams({
            legacy_item_id: id,
          }).toString()}`,
          { marketplaceId: getConfig().marketplaceId },
        );
        const browseListedAt = extractBrowseListedAt(payload);
        return {
          id,
          listedAt: browseListedAt || await fetchListingPageListedAt(id),
        };
      }),
    );

    for (const entry of settled) {
      if (entry.status === "fulfilled") {
        const { id, listedAt } = entry.value;
        cache[id] = {
          ...(cache[id] || {}),
          listedAt: listedAt || null,
          fetchedAt: new Date().toISOString(),
        };
        result[id] = listedAt || null;
      }
    }
  }

  await saveBrowseCache();
  return result;
}

export async function fetchBrowseListingImagesByLegacyId(legacyItemIds = []) {
  const ids = [...new Set((Array.isArray(legacyItemIds) ? legacyItemIds : [])
    .map(normalizeLegacyItemId)
    .filter(Boolean))];
  if (!ids.length) return {};

  const cache = await loadBrowseCache();
  const result = {};
  const pending = [];
  for (const id of ids) {
    const cached = cache[id];
    if (
      cached &&
      Object.prototype.hasOwnProperty.call(cached, "imageUrl") &&
      cached.sport
    ) {
      result[id] = {
        imageUrl: cached.imageUrl || null,
        imageUrls: Array.isArray(cached.imageUrls) ? cached.imageUrls : [],
        sport: cached.sport || null,
      };
    } else {
      pending.push(id);
    }
  }

  if (!pending.length) return result;

  const concurrency = 8;
  for (let index = 0; index < pending.length; index += concurrency) {
    const batch = pending.slice(index, index + concurrency);
    const settled = await Promise.allSettled(
      batch.map(async (id) => {
        const payload = await request(
          `/buy/browse/v1/item/get_item_by_legacy_id?${new URLSearchParams({
            legacy_item_id: id,
          }).toString()}`,
          { marketplaceId: getConfig().marketplaceId },
        );
        const browseImageData = extractBrowseImageData(payload);
        const browseSport = extractBrowseSport(payload);
        const fallbackPageData = browseImageData.imageUrl && browseSport
          ? { imageUrl: browseImageData.imageUrl, imageUrls: browseImageData.imageUrls, sport: browseSport }
          : await fetchListingPageImageData(id);
        return {
          id,
          imageUrl: browseImageData.imageUrl || fallbackPageData.imageUrl || null,
          imageUrls: Array.isArray(browseImageData.imageUrls) && browseImageData.imageUrls.length
            ? browseImageData.imageUrls
            : Array.isArray(fallbackPageData.imageUrls)
              ? fallbackPageData.imageUrls
              : [],
          sport: browseSport || fallbackPageData.sport || null,
        };
      }),
    );

    for (const entry of settled) {
      if (entry.status === "fulfilled") {
        const { id, imageUrl, imageUrls, sport } = entry.value;
        cache[id] = {
          ...(cache[id] || {}),
          imageUrl: imageUrl || null,
          imageUrls: Array.isArray(imageUrls) ? imageUrls : [],
          sport: sport || null,
          fetchedAt: new Date().toISOString(),
        };
        result[id] = {
          imageUrl: imageUrl || null,
          imageUrls: Array.isArray(imageUrls) ? imageUrls : [],
          sport: sport || null,
        };
      }
    }
  }

  await saveBrowseCache();
  return result;
}
