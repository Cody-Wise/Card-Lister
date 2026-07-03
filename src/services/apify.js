import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nowIso } from "../lib/store.js";
import { getCacheEntry, upsertCacheEntry, hasSupabaseConfig } from "../lib/supabase.js";
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
  autographSearchTokens,
  autographTitleMatches,
  rookieStyleFromMetadata,
  rookieTitleMatches,
  parallelMatchesTitle,
  buildYearFirstParts,
} from "../lib/card-query.js";

// Naming note for anyone new to this file: sold-comp/pricing lookups went
// through three generations — CardHedge (original integration, still the
// live provider in production today: CARDHEDGE_API_KEY/CARDHEDGE_API_BASE_URL
// point at the real api.cardhedger.com) -> CardSight (an in-progress rename
// that was never actually deployed — CARDSIGHT_* env vars are read as an
// alias everywhere CARDHEDGE_* is, but are unset in production, so they're
// currently dead code paths, not a second live provider) -> Apify (the
// preferred path today for new sold-comp ingestion; see hasApifyConfig()
// call sites). Function names below still carry the "CardSight" branding
// from the unfinished rename. Deliberately NOT doing a mechanical rename
// here: a real fix means picking one clear name for the shared abstraction
// (arguably neither "CardHedge" nor "CardSight", since Apify is now
// preferred) and is better done alongside splitting this file up (see
// README's "Known rough edges" / src/app.js size) rather than as a
// find-replace against a name that's itself borrowed from a specific vendor.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const marketHeatCachePath = path.join(rootDir, "data", "market-heat-cache.json");
const MARKET_HEAT_REFRESH_MS = Number(
  process.env.MARKET_HEAT_REFRESH_MS || 7 * 24 * 60 * 60 * 1000,
);
const MARKET_HEAT_DEFAULT_SAMPLE_SIZE = Number(process.env.APIFY_MARKET_HEAT_SAMPLE_SIZE || 500);
const MARKET_HEAT_DEFAULT_LIMIT = Number(process.env.MARKET_HEAT_DEFAULT_LIMIT || 50);
const CARDHEDGE_API_BASE_URL = (
  process.env.CARDSIGHT_API_BASE_URL ||
  process.env.CARDHEDGE_API_BASE_URL ||
  "https://api.cardsight.ai"
).replace(
  /\/+$/,
  "",
);
const CARDHEDGE_COMPS_COUNT = Number(
  process.env.CARDSIGHT_COMPS_COUNT || process.env.CARDHEDGE_COMPS_COUNT || 50,
);
const CARDHEDGE_HEAT_PAGES = Number(process.env.CARDHEDGE_HEAT_PAGES || 5);
const CARDHEDGE_MIN_INTERVAL_MS = Number(
  process.env.CARDSIGHT_MIN_INTERVAL_MS || process.env.CARDHEDGE_MIN_INTERVAL_MS || 1500,
);
const CARDHEDGE_MAX_RETRIES = Number(
  process.env.CARDSIGHT_MAX_RETRIES || process.env.CARDHEDGE_MAX_RETRIES || 2,
);
const CARDHEDGE_LOOKUP_CACHE_MS = Number(
  process.env.CARDSIGHT_LOOKUP_CACHE_MS ||
    process.env.CARDHEDGE_LOOKUP_CACHE_MS ||
    24 * 60 * 60 * 1000,
);
const CARDSIGHT_MATCH_CACHE_VERSION = String(process.env.CARDSIGHT_MATCH_CACHE_VERSION || "v3").trim() || "v3";
const CARDSIGHT_PRICING_PERIOD = String(process.env.CARDSIGHT_PRICING_PERIOD || "all").trim() || "all";

let cardHedgeRequestQueue = Promise.resolve();
let cardHedgeLastRequestAt = 0;

const CARDHEDGE_SPORT_CATEGORY_MAP = {
  basketball: "Basketball",
  football: "Football",
  soccer: "Soccer",
  baseball: "Baseball",
};

const MARKET_HEAT_SPORTS = {
  basketball: {
    label: "Basketball",
    keyword: "basketball card",
    players: [
      { name: "Michael Jordan" },
      { name: "LeBron James" },
      { name: "Kobe Bryant" },
      { name: "Victor Wembanyama", aliases: ["victor wembanyama", "wembanyama", "wemby"] },
      { name: "Anthony Edwards" },
      { name: "Stephen Curry", aliases: ["stephen curry", "steph curry"] },
      { name: "Luka Doncic" },
      { name: "Giannis Antetokounmpo" },
      { name: "Jayson Tatum" },
      { name: "Shai Gilgeous-Alexander" },
      { name: "Nikola Jokic" },
      { name: "Ja Morant" },
      { name: "Kevin Durant" },
      { name: "Kyrie Irving" },
      { name: "Devin Booker" },
      { name: "Anthony Davis" },
      { name: "Jaylen Brown" },
      { name: "Chet Holmgren" },
      { name: "Paolo Banchero" },
      { name: "Tyrese Haliburton" },
      { name: "LaMelo Ball" },
      { name: "Caitlin Clark" },
      { name: "Allen Iverson" },
      { name: "Shaquille O'Neal" },
      { name: "Tim Duncan" },
      { name: "Kevin Garnett" },
      { name: "Jalen Brunson" },
      { name: "Damian Lillard" },
      { name: "Trae Young" },
      { name: "Franz Wagner" },
      { name: "Amen Thompson" },
      { name: "Ausar Thompson" },
      { name: "Scottie Barnes" },
      { name: "James Harden" },
      { name: "Draymond Green" },
      { name: "Joel Embiid" },
      { name: "Kawhi Leonard" },
      { name: "Giannis Antetokounmpo" },
    ],
  },
  football: {
    label: "Football",
    keyword: "football card",
    players: [
      { name: "Tom Brady" },
      { name: "Patrick Mahomes" },
      { name: "Josh Allen" },
      { name: "Lamar Jackson" },
      { name: "Joe Burrow" },
      { name: "Jalen Hurts" },
      { name: "Justin Herbert" },
      { name: "C.J. Stroud", aliases: ["cj stroud", "c j stroud"] },
      { name: "Caleb Williams" },
      { name: "Jayden Daniels" },
      { name: "Drake Maye" },
      { name: "Brock Purdy" },
      { name: "Aaron Rodgers" },
      { name: "Peyton Manning" },
      { name: "Eli Manning" },
      { name: "Jerry Rice" },
      { name: "Randy Moss" },
      { name: "Bo Nix" },
      { name: "Michael Penix Jr" },
      { name: "Trevor Lawrence" },
      { name: "Travis Kelce" },
      { name: "Justin Jefferson" },
      { name: "Ja'Marr Chase", aliases: ["jamarr chase", "ja'marr chase"] },
      { name: "Shedeur Sanders" },
      { name: "Travis Hunter" },
      { name: "Arch Manning" },
      { name: "Barry Sanders" },
      { name: "Saquon Barkley" },
      { name: "Bijan Robinson" },
      { name: "Malik Nabers" },
      { name: "Marvin Harrison Jr" },
      { name: "Joe Montana" },
      { name: "Dan Marino" },
      { name: "Emmitt Smith" },
      { name: "Davante Adams" },
      { name: "Travis Kelce" },
      { name: "Stefon Diggs" },
      { name: "CeeDee Lamb" },
      { name: "Justin Fields" },
      { name: "Lamar Jackson" },
      { name: "Josh Jacobs" },
      { name: "Alvin Kamara" },
      { name: "Jonathan Taylor" },
      { name: "Derrick Henry" },
    ],
  },
  soccer: {
    label: "Soccer",
    keyword: "soccer card",
    players: [
      { name: "Lionel Messi" },
      { name: "Cristiano Ronaldo" },
      { name: "Kylian Mbappe" },
      { name: "Erling Haaland" },
      { name: "Jude Bellingham" },
      { name: "Lamine Yamal" },
      { name: "Vinicius Junior", aliases: ["vinicius junior", "vinicius jr", "vini jr"] },
      { name: "Pedri" },
      { name: "Bukayo Saka" },
      { name: "Cole Palmer" },
      { name: "Endrick" },
      { name: "Neymar Jr", aliases: ["neymar jr", "neymar"] },
      { name: "Diego Maradona" },
      { name: "Pele" },
      { name: "Zinedine Zidane" },
      { name: "Ronaldinho" },
      { name: "Kaka" },
      { name: "Raphinha" },
      { name: "Rodri" },
      { name: "Robert Lewandowski" },
      { name: "Harry Kane" },
      { name: "Phil Foden" },
      { name: "Jamal Musiala" },
      { name: "Florian Wirtz" },
      { name: "Arda Guler" },
      { name: "Christian Pulisic" },
      { name: "Kevin De Bruyne" },
      { name: "Mohamed Salah" },
      { name: "Sergio Ramos" },
      { name: "Karim Benzema" },
      { name: "N'Golo Kante" },
      { name: "Bernardo Silva" },
      { name: "Sadio Mane" },
    ],
  },
  baseball: {
    label: "Baseball",
    keyword: "baseball card",
    players: [
      { name: "Aaron Judge" },
      { name: "Mike Trout" },
      { name: "Mookie Betts" },
      { name: "Shohei Ohtani" },
      { name: "Jacob deGrom" },
      { name: "Nolan Arenado" },
      { name: "Manny Machado" },
      { name: "Paul Goldschmidt" },
      { name: "Francisco Lindor" },
      { name: "Ronald Acuna Jr" },
      { name: "Bobby Witt Jr" },
      { name: "Vladimir Guerrero Jr" },
      { name: "Jose Altuve" },
      { name: "Freddie Freeman" },
      { name: "Ozzie Albies" },
      { name: "Fernando Tatis Jr" },
      { name: "Cody Bellinger" },
      { name: "Marcus Semien" },
      { name: "Trea Turner" },
      { name: "Xander Bogaerts" },
      { name: "Jose Ramirez" },
      { name: "Gerrit Cole" },
      { name: "Justin Verlander" },
      { name: "Clayton Kershaw" },
      { name: "Max Scherzer" },
      { name: "Corbin Burnes" },
      { name: "Ketel Marte" },
      { name: "Bo Bichette" },
      { name: "Mookie Betts" },
      { name: "Albert Pujols" },
      { name: "Ken Griffey Jr" },
      { name: "Mookie Betts" },
      { name: "Paul Skenes" },
      { name: "Sandy Alcantara" },
      { name: "Mookie Betts" },
      { name: "Mike Moustakas" },
      { name: "Ohtani" },
      { name: "Bobby Witt Jr" },
      { name: "Vlad Guerrero Jr" },
      { name: "Nolan Gorman" },
      { name: "Xander Bogaerts" },
      { name: "Kris Bryant" },
      { name: "Mookie Betts" },
      { name: "Freddie Freeman" },
      { name: "Jose Ramirez" },
      { name: "Cesar Hernandez" },
      { name: "Brandon Nimmo" },
      { name: "Justin Verlander" },
      { name: "Mookie Betts" },
      { name: "Bryson DeChambeau" },
      { name: "Dylan Carlson" },
      { name: "Mike Trout" },
      { name: "Aaron Judge" },
      { name: "Nolan Arenado" },
      { name: "Pete Alonso" },
    ],
  },
};

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
    metadata.serialNumber,
  ].filter(Boolean);

  for (const field of fields) {
    if (title.includes(normalize(field))) score += 2;
  }

  if (
    metadata.playerName &&
    metadata.cardNumber &&
    title.includes(normalize(`${metadata.playerName} ${metadata.cardNumber}`))
  ) {
    score += 2;
  }

  if (keyword && metadata.playerName && keyword.includes(normalize(metadata.playerName)))
    score += 1;
  if (keyword && metadata.cardNumber && keyword.includes(normalize(metadata.cardNumber)))
    score += 1;

  if (metadata.rookieFlag) {
    const ratedRookieStyle =
      /rated rookie/.test(normalize(metadata.variantLabel || "")) ||
      /optic/.test(normalize(metadata.setName || ""));
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
    if (
      /\bautograph\b/.test(title) ||
      /\bsignature\b/.test(title) ||
      /\bsigned\b/.test(title) ||
      /\bauto\b/.test(title)
    ) {
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
    const key =
      listing.listingId ||
      `${normalize(listing.title)}:${listing.totalPrice ?? listing.salePrice ?? ""}`;
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
    actorId: (process.env.APIFY_EBAY_SOLD_ACTOR_ID || "caffein.dev~ebay-sold-listings").replaceAll(
      "/",
      "~",
    ),
    daysToScrape: Number(process.env.APIFY_EBAY_SOLD_DAYS_TO_SCRAPE || 60),
    count: Number(process.env.APIFY_EBAY_SOLD_COUNT || 10),
    ebaySite: process.env.APIFY_EBAY_SITE || "ebay.com",
    sortOrder: process.env.APIFY_EBAY_SORT_ORDER || "endedRecently",
    itemLocation: process.env.APIFY_EBAY_ITEM_LOCATION || "default",
  };
}

function getCardHedgeConfig() {
  return {
    apiKey: process.env.CARDSIGHT_API_KEY || process.env.CARDHEDGE_API_KEY || "",
    baseUrl: CARDHEDGE_API_BASE_URL,
    compsCount: Number(CARDHEDGE_COMPS_COUNT || 50),
  };
}

function isCardHedgeApifyFallbackEnabled() {
  const fallback = String(
    process.env.CARDSIGHT_USE_APIFY_FALLBACK || process.env.CARDHEDGE_USE_APIFY_FALLBACK || "",
  ).toLowerCase().trim();
  return fallback === "1" || fallback === "true" || fallback === "yes" || fallback === "on";
}

function getCardHedgeCategoryFromMetadata(metadata = {}) {
  const key = normalize(metadata.sport || metadata.category || "").toLowerCase();
  return CARDHEDGE_SPORT_CATEGORY_MAP[key] || "Sports Cards";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const timestamp = Date.parse(String(value));
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, timestamp - Date.now());
}

function getCardHedgeThrottleMs() {
  return clampPositiveInt(CARDHEDGE_MIN_INTERVAL_MS, 6500, 60000);
}

function getCardHedgeRetryLimit() {
  return clampPositiveInt(CARDHEDGE_MAX_RETRIES, 2, 5);
}

async function enqueueCardHedgeRequest(task) {
  const run = async () => {
    const throttleMs = getCardHedgeThrottleMs();
    const waitMs = Math.max(0, cardHedgeLastRequestAt + throttleMs - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    try {
      return await task();
    } finally {
      cardHedgeLastRequestAt = Date.now();
    }
  };

  const next = cardHedgeRequestQueue.then(run, run);
  cardHedgeRequestQueue = next.catch(() => {});
  return next;
}

function buildCardHedgeCacheProviderPrefix() {
  return process.env.CARDSIGHT_API_KEY ? "cardsight" : "cardhedge";
}

async function callCardHedgeApi(path, payload = {}) {
  const config = getCardHedgeConfig();
  if (!config.apiKey) {
    throw new Error("Missing CARDSIGHT_API_KEY");
  }

  return enqueueCardHedgeRequest(async () => {
    const request =
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      ("method" in payload || "searchParams" in payload || "body" in payload)
        ? payload
        : { method: "POST", body: payload };
    const method = String(request.method || "GET").toUpperCase();
    const url = new URL(`${config.baseUrl}${path}`);
    const searchParams = request.searchParams || null;
    if (searchParams && typeof searchParams === "object") {
      for (const [key, value] of Object.entries(searchParams)) {
        if (value == null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }
    const retryLimit = getCardHedgeRetryLimit();

    for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
      const headers = {
        Accept: "application/json",
        "X-API-Key": config.apiKey,
      };
      let body;
      if (request.body != null) {
        if (typeof FormData !== "undefined" && request.body instanceof FormData) {
          body = request.body;
        } else {
          headers["Content-Type"] = "application/json";
          body = JSON.stringify(request.body);
        }
      }
      const response = await fetch(url, {
        method,
        headers,
        body,
      });

      const payloadJson = await response.json().catch(() => ({}));
      if (response.ok) {
        return payloadJson;
      }

      const message =
        payloadJson?.detail || payloadJson?.error || `HTTP ${response.status}`;
      if (response.status === 429 && attempt < retryLimit) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        const backoffMs = retryAfterMs ?? getCardHedgeThrottleMs() * (attempt + 1);
        await sleep(Math.min(Math.max(backoffMs, 1000), 60000));
        continue;
      }
      if (response.status === 429) {
        throw new Error(
          `CardSight rate limit hit. Wait about a minute and try again. Last response: ${message}`,
        );
      }
      throw new Error(`CardSight API request failed (${response.status}): ${message}`);
    }

    throw new Error("CardSight API request failed after retries.");
  });
}

function normalizeCardHedgeRequestedGrade(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^raw$/i.test(raw)) return "Raw";
  const normalized = raw.toUpperCase().replace(/\s+/g, " ").trim();
  const match = normalized.match(/^(PSA|BGS|SGC|CGC|CSG)\s*([0-9]+(?:\.[0-9])?)$/);
  if (match) {
    return `${match[1]} ${match[2]}`;
  }
  return normalized;
}

function resolveCardHedgeCompGrade(metadata = {}) {
  const override = normalizeCardHedgeRequestedGrade(metadata.compGradeOverride);
  if (override) return override;
  if (!metadata.gradedFlag) return "Raw";
  const rawGrade = String(metadata.grade || "").trim();
  if (!rawGrade) return "Raw";
  if (/raw/i.test(rawGrade)) return "Raw";
  const normalized = normalizeCardHedgeRequestedGrade(rawGrade);
  if (normalized) return normalized;
  const numeric = rawGrade.toUpperCase().replace(/[^0-9.]/g, "");
  if (numeric) return `PSA ${numeric}`;
  return rawGrade.toUpperCase();
}

function buildCardHedgeQuery(metadata = {}) {
  const structured = [
    metadata.year,
    metadata.playerName,
    metadata.setName,
    metadata.cardNumber,
    metadata.parallel,
    metadata.variantLabel,
    metadata.rookieFlag ? "Rookie" : null,
    metadata.autographFlag ? "Autograph" : null,
  ]
    .filter(Boolean)
    .map(cleanQueryText)
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  const titleHint = cleanQueryText(metadata.titleHint || "")
    .replace(/\s+/g, " ")
    .trim();

  if (titleHint && (!structured || titleHint.length > structured.length)) {
    return titleHint;
  }

  if (structured && titleHint) {
    const normalizedStructured = normalize(structured);
    const normalizedTitleHint = normalize(titleHint);
    if (normalizedStructured && normalizedTitleHint && !normalizedTitleHint.includes(normalizedStructured)) {
      return `${structured} ${titleHint}`.replace(/\s+/g, " ").trim();
    }
  }

  return structured || titleHint;
}

function getCompDataProvider() {
  const explicit = String(
    process.env.COMP_DATA_PROVIDER || process.env.SOLD_COMP_PROVIDER || "",
  )
    .toLowerCase()
    .trim();
  if (explicit === "apify" || explicit === "cardhedge" || explicit === "cardsight") {
    return explicit === "apify" ? "apify" : "cardhedge";
  }
  if (getApifyConfig().token) return "apify";
  return getCardHedgeConfig().apiKey ? "cardhedge" : "apify";
}

function shouldForceApifyProvider(metadata = {}) {
  const explicit = String(metadata.compDataProvider || metadata.provider || "").toLowerCase().trim();
  if (explicit === "apify") return true;
  const haystack = normalize(
    [
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
      .join(" "),
  );
  return /\b(trading cards|pokemon|magic|mtg|yugioh|yu gi oh|lorcana|one piece|digimon|star wars|marvel|dc|non sport|non-sport)\b/.test(
    haystack,
  );
}

function resolveApifySoldCount(metadata = {}) {
  const configuredCount = clampPositiveInt(
    Number(process.env.APIFY_EBAY_SOLD_COUNT || 10),
    10,
    100,
  );
  return shouldForceApifyProvider(metadata) ? Math.max(configuredCount, 15) : configuredCount;
}

function getMarketHeatProvider() {
  return getApifyConfig().token ? "apify" : "apify";
}

function getMarketDataProvider() {
  return getCompDataProvider();
}

function clampPositiveInt(value, fallback, max = 1000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(1, Math.round(parsed)), max);
}

async function loadMarketHeatCache() {
  try {
    const raw = await fs.readFile(marketHeatCachePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { reports: {} };
  } catch {
    return { reports: {} };
  }
}

async function saveMarketHeatCache(cache) {
  await fs.mkdir(path.dirname(marketHeatCachePath), { recursive: true });
  await fs.writeFile(marketHeatCachePath, JSON.stringify(cache, null, 2));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function buildCardHedgeCacheKey(type, value) {
  return `${buildCardHedgeCacheProviderPrefix()}:${CARDSIGHT_MATCH_CACHE_VERSION}:${type}:${createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")}`;
}

function cacheExpiryIso(ttlMs) {
  return Number.isFinite(ttlMs) && ttlMs > 0 ? new Date(Date.now() + ttlMs).toISOString() : null;
}

function cacheEntryFresh(entry) {
  const expiresAt = Date.parse(String(entry?.expiresAt || ""));
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt > Date.now();
}

async function readCardHedgeCacheEntry(cacheKey) {
  if (!hasSupabaseConfig()) return null;
  try {
    const entry = await getCacheEntry(cacheKey);
    if (!entry || !cacheEntryFresh(entry)) return null;
    return entry.payload || null;
  } catch {
    return null;
  }
}

async function writeCardHedgeCacheEntry({
  cacheKey,
  cacheType,
  payload,
  metadata = null,
  ttlMs = CARDHEDGE_LOOKUP_CACHE_MS,
}) {
  if (!hasSupabaseConfig()) return null;
  try {
    return await upsertCacheEntry({
      cacheKey,
      cacheType,
      payload,
      metadata,
      expiresAt: cacheExpiryIso(ttlMs),
    });
  } catch {
    return null;
  }
}

function marketHeatCacheKey({ days, sampleSize, limitPlayers, provider }) {
  return `${provider}:${days}:${sampleSize}:${limitPlayers}`;
}

function marketHeatFresh(snapshot) {
  const generatedAt = snapshot?.generatedAt ? new Date(snapshot.generatedAt).getTime() : NaN;
  if (!Number.isFinite(generatedAt)) return false;
  return Date.now() - generatedAt < MARKET_HEAT_REFRESH_MS;
}

function marketHeatTitleAllowed(title) {
  const haystack = normalize(title);
  if (!haystack) return false;
  if (
    /\b(lot|bundle|complete set|team set|set break|case break|wax|blaster|mega|hobby box|hobby|box|pack|fat pack|cello|tin)\b/.test(
      haystack,
    )
  ) {
    return false;
  }
  return /\b(card|rc|rookie|auto|autograph|prizm|refractor|patch|numbered|parallel)\b/.test(
    haystack,
  );
}

function marketHeatPlayerEntries(sportKey) {
  const config = MARKET_HEAT_SPORTS[sportKey];
  const seen = new Set();
  const entries = (config?.players || []).flatMap((entry) => {
    if (typeof entry === "string") {
      return [{ name: entry, aliases: [entry] }];
    }
    const aliases = [entry.name, ...(entry.aliases || [])];
    return { name: entry.name, aliases };
  });

  return entries.filter((entry) => {
    if (!entry?.name) return false;
    const key = normalize(entry.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function matchMarketHeatPlayer(title, sportKey) {
  const haystack = normalize(title);
  const matches = [];
  for (const player of marketHeatPlayerEntries(sportKey)) {
    if (player.aliases.some((alias) => haystack.includes(normalize(alias)))) {
      matches.push(player.name);
    }
  }
  const unique = [...new Set(matches)];
  if (unique.length !== 1) return null;
  return unique[0];
}

async function fetchApifyMarketplaceSoldItems({
  keyword,
  daysToScrape,
  count,
  itemCondition = "any",
}) {
  const config = getApifyConfig();
  if (!config.token) {
    throw new Error("Missing APIFY_TOKEN");
  }

  const input = {
    keywords: [keyword],
    daysToScrape,
    count,
    ebaySite: config.ebaySite,
    sortOrder: config.sortOrder,
    itemLocation: config.itemLocation,
    itemCondition,
  };

  const response = await fetch(
    `https://api.apify.com/v2/acts/${config.actorId}/run-sync-get-dataset-items?token=${encodeURIComponent(config.token)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(input),
    },
  );

  const payload = await response.json();
  if (!response.ok) {
    const message =
      payload?.error?.message || payload?.message || payload?.error || `HTTP ${response.status}`;
    throw new Error(`Apify sold listings request failed (${response.status}): ${message}`);
  }

  return Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.items)
      ? payload.items
      : [];
}

function getCardHedgeSalesCount(row, days) {
  const sevenDaySales = toNumber(row["7 Day Sales"]);
  if (days <= 7) return sevenDaySales || 0;
  return toNumber(row["30 Day Sales"]) || sevenDaySales || 0;
}

function getCardHedgeCardPrice(row) {
  const prices = Array.isArray(row?.prices) ? row.prices : [];
  if (!prices.length) return 0;
  const raw = prices.find((entry) => String(entry?.grade || "").toLowerCase() === "raw");
  const preferred = raw || prices[0];
  return toNumber(preferred?.price) || 0;
}

function normalizeCardHedgeSampleDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

async function fetchCardHedgeMarketHeatRows({ sportKey, days, sampleSize }) {
  const category = CARDHEDGE_SPORT_CATEGORY_MAP[sportKey] || null;
  if (!category) return [];

  const sortBy = days <= 7 ? "sales_7day" : "sales_30day";
  const pageSize = Math.min(
    100,
    Math.max(20, clampPositiveInt(sampleSize, 1, 100)),
  );
  const maxPages = clampPositiveInt(CARDHEDGE_HEAT_PAGES, 1, 10);
  const targetRows = clampPositiveInt(sampleSize, 20, 500);
  const rows = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const response = await callCardHedgeApi("/v1/cards/search-cards-wsort", {
      category,
      sort_by: sortBy,
      sort_order: "desc",
      page,
      page_size: pageSize,
    });

    const cards = Array.isArray(response?.cards) ? response.cards : [];
    rows.push(...cards);
    const pagesAvailable = Number(response?.pages);
    if (rows.length >= targetRows) break;
    if (Number.isFinite(pagesAvailable) && page >= pagesAvailable) break;
    if (cards.length < pageSize) break;
  }

  return rows.slice(0, targetRows);
}

function buildCardHedgeMarketHeatSportLeaderboard(rows, sportKey, limitPlayers, days) {
  const sportConfig = MARKET_HEAT_SPORTS[sportKey];
  const players = new Map();
  let matchedListings = 0;
  let unmatchedListings = 0;

  for (const row of rows) {
    const player = String(row?.player || "").trim();
    const salesCount = getCardHedgeSalesCount(row, days || 30);
    if (!player || !salesCount) {
      unmatchedListings += 1;
      continue;
    }

    const price = getCardHedgeCardPrice(row);
    matchedListings += salesCount;
    const lastSoldAt = normalizeCardHedgeSampleDate(row?.latest_sold_at || row?.endedAt || row?.soldAt);
    const current = players.get(player) || {
      player,
      unitsSold: 0,
      listingsMatched: 0,
      totalRevenue: 0,
      lastSoldAt: null,
      sampleTitles: [],
    };
    current.unitsSold += salesCount;
    current.listingsMatched += 1;
    current.totalRevenue += price * salesCount;
    if (lastSoldAt && (!current.lastSoldAt || lastSoldAt > current.lastSoldAt)) {
      current.lastSoldAt = lastSoldAt;
    }
    const label = row?.description || row?.title || row?.search_text || "";
    if (current.sampleTitles.length < 3 && label) {
      current.sampleTitles.push(label);
    }
    players.set(player, current);
  }

  const leaderboard = [...players.values()]
    .map((entry) => ({
      player: entry.player,
      unitsSold: entry.unitsSold,
      listingsMatched: entry.listingsMatched,
      totalRevenue: Number(entry.totalRevenue.toFixed(2)),
      averagePrice: entry.unitsSold
        ? Number((entry.totalRevenue / entry.unitsSold).toFixed(2))
        : 0,
      lastSoldAt: entry.lastSoldAt,
      sampleTitles: entry.sampleTitles,
    }))
    .sort(
      (a, b) => b.unitsSold - a.unitsSold || b.totalRevenue - a.totalRevenue || String(a.player).localeCompare(String(b.player)),
    )
    .slice(0, limitPlayers)
    .map((entry, index) => ({
      rank: index + 1,
      ...entry,
    }));

  return {
    players: leaderboard,
    matchedListings,
    unmatchedListings,
  };
}

async function buildCardHedgeMarketHeatSnapshot({ days, sampleSize, limitPlayers }) {
  const sports = [];

  for (const sportKey of Object.keys(MARKET_HEAT_SPORTS)) {
    const rows = await fetchCardHedgeMarketHeatRows({
      sportKey,
      days,
      sampleSize: sampleSize,
    });
    const leaderboard = buildCardHedgeMarketHeatSportLeaderboard(
      rows,
      sportKey,
      limitPlayers,
      days,
    );
    sports.push({
      sport: MARKET_HEAT_SPORTS[sportKey]?.label || sportKey,
      sportKey,
      query: `${MARKET_HEAT_SPORTS[sportKey]?.label || sportKey} cards`,
      sampleCount: rows.length,
      matchedListings: leaderboard.matchedListings,
      unmatchedListings: leaderboard.unmatchedListings,
      players: leaderboard.players,
    });
  }

  return {
    generatedAt: nowIso(),
    windowDays: days,
    sampleSizePerSport: sampleSize,
    limitPlayers,
    source: "cardhedge_market_heat",
    sports,
  };
}

function buildMarketHeatSportLeaderboard(rows, sportKey, limitPlayers) {
  const sportConfig = MARKET_HEAT_SPORTS[sportKey];
  const players = new Map();
  let matchedListings = 0;
  let unmatchedListings = 0;

  for (const row of rows) {
    const title = row?.title || row?.keyword || "";
    if (!marketHeatTitleAllowed(title)) continue;
    const player = matchMarketHeatPlayer(title, sportKey);
    if (!player) {
      unmatchedListings += 1;
      continue;
    }

    matchedListings += 1;
    const totalPrice =
      toNumber(row.totalPrice) ??
      ((toNumber(row.soldPrice) || 0) + (toNumber(row.shippingPrice) || 0));
    const soldAt = row.endedAt || row.soldAt || null;
    const current = players.get(player) || {
      player,
      unitsSold: 0,
      listingsMatched: 0,
      totalRevenue: 0,
      lastSoldAt: null,
      sampleTitles: [],
    };
    current.unitsSold += 1;
    current.listingsMatched += 1;
    current.totalRevenue += totalPrice || 0;
    if (soldAt && (!current.lastSoldAt || soldAt > current.lastSoldAt)) {
      current.lastSoldAt = soldAt;
    }
    if (current.sampleTitles.length < 3 && title) {
      current.sampleTitles.push(title);
    }
    players.set(player, current);
  }

  const leaderboard = [...players.values()]
    .map((entry) => ({
      player: entry.player,
      unitsSold: entry.unitsSold,
      listingsMatched: entry.listingsMatched,
      totalRevenue: Number(entry.totalRevenue.toFixed(2)),
      averagePrice: entry.unitsSold
        ? Number((entry.totalRevenue / entry.unitsSold).toFixed(2))
        : 0,
      lastSoldAt: entry.lastSoldAt,
      sampleTitles: entry.sampleTitles,
    }))
    .sort(
      (a, b) =>
        b.unitsSold - a.unitsSold ||
        b.totalRevenue - a.totalRevenue ||
        String(a.player).localeCompare(String(b.player)),
    )
    .slice(0, limitPlayers)
    .map((entry, index) => ({
      rank: index + 1,
      ...entry,
    }));

  return {
    sport: sportConfig?.label || sportKey,
    sportKey,
    query: sportConfig?.keyword || sportKey,
    matchedListings,
    unmatchedListings,
    players: leaderboard,
  };
}

async function buildMarketHeatSnapshot({ days, sampleSize, limitPlayers }) {
  const provider = getMarketHeatProvider();
  if (provider === "cardhedge") {
    try {
      return await buildCardHedgeMarketHeatSnapshot({ days, sampleSize, limitPlayers });
    } catch (error) {
      const config = getApifyConfig();
      if (!config.token || !isCardHedgeApifyFallbackEnabled()) {
        throw error;
      }
      console.warn("CardHedge market heat failed, falling back to Apify", error.message);
    }
  }

  const sports = [];
  for (const sportKey of Object.keys(MARKET_HEAT_SPORTS)) {
    const sportConfig = MARKET_HEAT_SPORTS[sportKey];
    const rows = await fetchApifyMarketplaceSoldItems({
      keyword: sportConfig.keyword,
      daysToScrape: days,
      count: sampleSize,
      itemCondition: "any",
    });
    sports.push({
      ...buildMarketHeatSportLeaderboard(rows, sportKey, limitPlayers),
      sampleCount: rows.length,
    });
  }

  return {
    generatedAt: nowIso(),
    windowDays: days,
    sampleSizePerSport: sampleSize,
    limitPlayers,
    source: "apify_ebay_sold_market_heat",
    sports,
  };
}

export async function getApifyMarketHeatReport({
  days = 7,
  sampleSize = MARKET_HEAT_DEFAULT_SAMPLE_SIZE,
  limitPlayers = MARKET_HEAT_DEFAULT_LIMIT,
  sport = "all",
  refresh = false,
} = {}) {
  const normalizedDays = clampPositiveInt(days, 7, 30);
  const normalizedSampleSize = clampPositiveInt(sampleSize, MARKET_HEAT_DEFAULT_SAMPLE_SIZE, 1000);
  const normalizedLimitPlayers = clampPositiveInt(limitPlayers, MARKET_HEAT_DEFAULT_LIMIT, 50);
  const normalizedSport = String(sport || "all").trim().toLowerCase();
  const provider = getMarketHeatProvider();
  const cacheKey = marketHeatCacheKey({
    provider,
    days: normalizedDays,
    sampleSize: normalizedSampleSize,
    limitPlayers: normalizedLimitPlayers,
  });

  let snapshot = await readCardHedgeCacheEntry(cacheKey);
  if (!snapshot) {
    const cache = await loadMarketHeatCache();
    snapshot = cache.reports?.[cacheKey] || null;
  }
  let cacheStatus = "cached";

  if (refresh || !snapshot || !marketHeatFresh(snapshot)) {
    snapshot = await buildMarketHeatSnapshot({
      days: normalizedDays,
      sampleSize: normalizedSampleSize,
      limitPlayers: normalizedLimitPlayers,
    });
    await writeCardHedgeCacheEntry({
      cacheKey,
      cacheType: "market_heat",
      payload: snapshot,
      metadata: {
        provider,
        days: normalizedDays,
        sampleSize: normalizedSampleSize,
        limitPlayers: normalizedLimitPlayers,
      },
      ttlMs: MARKET_HEAT_REFRESH_MS,
    });
    const cache = await loadMarketHeatCache();
    cache.reports = cache.reports || {};
    cache.reports[cacheKey] = snapshot;
    await saveMarketHeatCache(cache);
    cacheStatus = "refreshed";
  }

  const sports = normalizedSport && normalizedSport !== "all"
    ? (snapshot.sports || []).filter((entry) => entry.sportKey === normalizedSport)
    : snapshot.sports || [];

  return {
    ...snapshot,
    cacheStatus,
    sports,
    availableSports: Object.entries(MARKET_HEAT_SPORTS).map(([sportKey, value]) => ({
      sportKey,
      sport: value.label,
    })),
  };
}

export function hasApifyConfig() {
  return Boolean(getApifyConfig().token || getCardHedgeConfig().apiKey);
}

function buildApifyKeywords(metadata = {}) {
  const queries = [];
  const baseHint = Boolean(metadata.baseHint);
  const parallelHint = baseHint ? null : inferParallelHint(metadata);
  const searchSetName = resolveSearchSetName(
    metadata,
    baseHint ? null : parallelHint || metadata.parallel,
  );

  const exact = buildYearFirstParts(
    {
      ...metadata,
      searchSetName,
      parallel: null,
      serialNumber: null,
      printRun: derivedPrintRun(metadata),
    },
    { includeParallel: false },
  )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
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
    const rookie = buildYearFirstParts(
      {
        ...metadata,
        searchSetName,
        parallel: metadata.parallel || null,
      },
      { includeParallel: false },
    )
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (rookie) queries.push(rookie);
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

  const concise = [
    metadata.year,
    metadata.playerName,
    searchSetName || metadata.setName,
    metadata.cardNumber,
    metadata.autographFlag ? "Autograph" : null,
    baseHint ? null : metadata.parallel,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (concise) queries.push(concise);

  return [...new Set(queries.filter(Boolean))].slice(0, 6);
}

export function buildApifyLookupKey(metadata = {}) {
  return [
    buildCardHedgeCacheProviderPrefix(),
    CARDSIGHT_MATCH_CACHE_VERSION,
    metadata.playerName || "",
    metadata.year || "",
    metadata.setName || "",
    metadata.cardNumber || "",
    metadata.parallel || "",
    metadata.compGradeOverride || "",
    metadata.compMatchMode || "auto",
    metadata.serialNumber || "",
    metadata.printRun || "",
    metadata.autographFlag ? "auto" : "noauto",
    metadata.rookieFlag ? "rookie" : "raw",
    metadata.variantLabel || "",
    metadata.titleHint || "",
    metadata.imageUrl || "",
  ].join("|");
}

function isStrictCompMatchMode(metadata = {}) {
  return normalize(metadata.compMatchMode || "") === "strict";
}

function strictCardHedgeDescriptionMatches(description, metadata = {}) {
  const text = String(description || "").trim();
  if (!text) return false;
  if (!matchesCoreCardIdentity(text, metadata)) return false;
  if (!rookieTitleMatches(text, metadata)) return false;
  if (!autographTitleMatches(text, metadata)) return false;
  if (metadata.baseHint && hasExplicitVariantSignals(text)) return false;
  if (metadata.parallel && !parallelMatchesTitle(text, metadata.parallel)) return false;
  if (metadata.serialNumber || metadata.printRun) {
    const run = String(metadata.printRun || "").trim();
    const serial = String(metadata.serialNumber || "").trim();
    if (run && !text.includes(`/${run}`) && !text.includes(run)) return false;
    if (serial && !text.includes(normalize(serial)) && run && !text.includes(`/${run}`)) return false;
  }
  return true;
}

function parseCardHedgeComps(rows = [], { sourceCardId = null } = {}) {
  const cards = Array.isArray(rows) ? rows : [];
  const parsed = [];

  const parsePrice = (value) => {
    if (typeof value === "number") return toNumber(value);
    if (typeof value === "string") {
      const normalized = value
        .replace(/[^0-9.\-]/g, "")
        .replace(/^(-?\d*\.\d{0,2}).*$/, "$1");
      return toNumber(normalized);
    }
    return toNumber(value);
  };

  const parseDate = (value) => {
    if (!value) return null;
    const parsed = Date.parse(String(value));
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
  };

  for (const row of cards) {
    const price = parsePrice(
      row?.price ||
        row?.sale_price ||
        row?.sold_price ||
        row?.final_price ||
        row?.total_price ||
        row?.totalAmount ||
        row?.amount,
    );
    if (price == null) continue;

    const soldAt = parseDate(
      row?.date ||
        row?.sale_date ||
        row?.sold_at ||
        row?.soldAt ||
        row?.saleDate ||
        row?.created_at ||
        row?.updated_at ||
        null,
    );
    const listingId = row?.price_history_id
      ? String(row.price_history_id)
      : row?.sale_id
        ? String(row.sale_id)
        : row?.id
          ? String(row.id)
          : `${sourceCardId || "cardhedge"}:${normalize(row?.title || "") || normalize(row?.description || "")}`;

    parsed.push({
      source: "cardhedge",
      listingId,
      title: row?.title || row?.description || "Unknown listing",
      conditionLabel: row?.condition || row?.sale_type || row?.price_source || null,
      salePrice: price,
      shippingPrice: null,
      totalPrice: price,
      soldAt: soldAt || null,
      url: row?.sale_url || row?.saleUrl || row?.url || row?.link || null,
      imageUrl: row?.image_url || row?.imageUrl || null,
      matchScore: 1,
      listingType: row?.listingType || row?.price_source || null,
      isBestOfferAccepted: false,
      sellerUsername: row?.seller || row?.sellerUsername || row?.seller_name || null,
      sellerPositivePercent: null,
      sellerFeedbackScore: null,
      scrapedAt: nowIso(),
      rawPayload: row,
      cardId: row?.card_id || sourceCardId || null,
      grade: row?.grade || null,
      parallelName: row?.parallel_name || row?.parallelName || null,
    });
  }

  return parsed;
}

function extractCardMatch(payload = {}) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.card_id) {
    return {
      cardId: String(payload.card_id),
      description: payload.description || payload.card_description || null,
      confidence: toNumber(payload.confidence),
      score: toNumber(payload.score),
      card: payload,
    };
  }
  if (payload.match) {
    return {
      cardId: payload.match.card_id ? String(payload.match.card_id) : null,
      description: payload.match.description || null,
      confidence: toNumber(payload.match.confidence),
      score: toNumber(payload.match.score),
      card: payload.match,
    };
  }
  return null;
}

function summarizeCardHedgeMatch(match, matchedVia = "card-match") {
  if (!match?.cardId) return null;
  return {
    cardId: match.cardId,
    description: match.description || null,
    confidence: match.confidence ?? null,
    score: match.score ?? null,
    matchedVia,
  };
}

function summarizeCardHedgePricingSummary(payload = {}, requestedGrade = "Raw") {
  if (payload?.raw && Array.isArray(payload.raw.records)) {
    const selected = selectCardSightPricingSection(payload, requestedGrade);
    const prices = selected.records
      .map((row) => toNumber(row?.price))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b);
    if (!prices.length) return null;
    const median = prices[Math.floor(prices.length / 2)] || prices[0];
    return {
      requestedGrade: selected.label || requestedGrade || "Raw",
      compPrice: median,
      high: prices[prices.length - 1] ?? median,
      low: prices[0] ?? median,
      countUsed: prices.length,
      countRequested: Number.isFinite(payload?.meta?.total_records)
        ? payload.meta.total_records
        : prices.length,
      timeWeighted: null,
    };
  }
  if (!payload || typeof payload !== "object") return null;
  const compPrice = toNumber(payload.comp_price);
  const high = toNumber(payload.high);
  const low = toNumber(payload.low);
  const countUsed = toNumber(payload.count_used);
  const countRequested = toNumber(payload.count_requested);
  const timeWeighted = toNumber(payload.time_weighted);
  if (
    compPrice == null &&
    high == null &&
    low == null &&
    countUsed == null &&
    countRequested == null &&
    timeWeighted == null
  ) {
    return null;
  }
  return {
    requestedGrade: requestedGrade || "Raw",
    compPrice,
    high,
    low,
    countUsed,
    countRequested,
    timeWeighted,
  };
}

function buildCardSightMatchDescription(result = {}, details = {}, parallel = null) {
  return [
    details?.releaseYear || result?.year || null,
    details?.name || result?.name || null,
    details?.releaseName || result?.releaseName || null,
    details?.setName || result?.setName || null,
    details?.number ? `#${details.number}` : null,
    parallel?.id && parallel.id !== "null" ? parallel.name : null,
    details?.description || null,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim() || null;
}

function scoreCardSightSearchResult(result = {}, metadata = {}) {
  const label = buildCardSightMatchDescription(result, result, null);
  let score = toNumber(result?.relevance) || 0;
  const normalizedLabel = normalize(label);
  if (matchesCoreCardIdentity(label, metadata)) score += 100;
  if (metadata.year && String(result?.year || "").trim() === String(metadata.year || "").trim()) score += 20;
  if (metadata.setName && normalizedLabel.includes(normalize(metadata.setName))) score += 25;
  if (metadata.setName && normalize(result?.releaseName || "").includes(normalize(metadata.setName))) score += 25;
  if (metadata.setName && normalize(result?.setName || "").includes(normalize(metadata.setName))) score += 15;
  if (metadata.cardNumber && normalize(label).includes(normalize(metadata.cardNumber))) score += 15;
  if (metadata.parallel && normalize(label).includes(normalize(metadata.parallel))) score += 20;
  if (metadata.baseHint && hasExplicitVariantSignals(label)) score -= 25;
  if (metadata.rookieFlag && rookieTitleMatches(label, metadata)) score += 10;
  if (metadata.autographFlag && autographTitleMatches(label, metadata)) score += 10;
  return score;
}

function buildCardSightSearchQueries(metadata = {}) {
  const playerName = cleanQueryText(metadata.playerName || "");
  const setName = cleanQueryText(metadata.setName || "");
  const titleHint = cleanQueryText(metadata.titleHint || "");
  const year = cleanQueryText(metadata.year || "");
  const base = [
    playerName && setName ? `${playerName} ${setName}` : null,
    playerName,
    titleHint,
    [playerName, metadata.parallel ? cleanQueryText(metadata.parallel) : null, setName].filter(Boolean).join(" "),
  ]
    .map((value) => cleanQueryText(value || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const deduped = [];
  const seen = new Set();
  for (const query of base) {
    const normalized = normalize(query.replace(year, "").trim());
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(query.replace(/\s+/g, " ").trim());
  }
  return deduped.slice(0, 4);
}

function resolveCardSightParallel(details = {}, metadata = {}, matchedParallelName = "") {
  const hint = String(metadata.parallel || metadata.variantLabel || matchedParallelName || "").trim();
  const parallels = Array.isArray(details?.parallels) ? details.parallels : [];
  if (!hint) {
    return { id: "null", name: "Base" };
  }
  const normalizedHint = normalize(hint);
  const match = parallels
    .map((parallel) => ({
      parallel,
      score:
        (normalize(parallel?.name).includes(normalizedHint) ? 50 : 0) +
        (normalize(parallel?.description).includes(normalizedHint) ? 25 : 0) +
        (metadata.printRun && String(parallel?.numberedTo || "") === String(metadata.printRun) ? 25 : 0),
    }))
    .sort((a, b) => b.score - a.score)
    .find((entry) => entry.score > 0);
  if (match?.parallel?.id) {
    return {
      id: String(match.parallel.id),
      name: match.parallel.name || hint,
      description: match.parallel.description || null,
    };
  }
  return {
    id: null,
    name: hint,
    description: null,
    unresolved: true,
  };
}

function parseRequestedGradeDescriptor(requestedGrade = "Raw") {
  const normalized = normalizeCardHedgeRequestedGrade(requestedGrade) || "Raw";
  if (normalized === "Raw") {
    return {
      label: "Raw",
      raw: true,
      company: null,
      gradeValue: null,
    };
  }
  const match = normalized.match(/^([A-Z]+)\s+(.+)$/);
  return {
    label: normalized,
    raw: false,
    company: match?.[1] || null,
    gradeValue: match?.[2] || normalized,
  };
}

function selectCardSightPricingSection(payload = {}, requestedGrade = "Raw") {
  const request = parseRequestedGradeDescriptor(requestedGrade);
  const rawRecords = Array.isArray(payload?.raw?.records) ? payload.raw.records : [];
  if (request.raw) {
    return {
      records: rawRecords,
      label: "Raw",
      warning: null,
    };
  }

  const gradedGroups = Array.isArray(payload?.graded) ? payload.graded : [];
  const exactCompany = gradedGroups.find(
    (group) => normalize(group?.company_name || "") === normalize(request.company || ""),
  );
  if (exactCompany) {
    const exactGrade = Array.isArray(exactCompany.grades)
      ? exactCompany.grades.find(
          (grade) => normalize(grade?.grade_value || "") === normalize(request.gradeValue || ""),
        )
      : null;
    if (exactGrade) {
      return {
        records: Array.isArray(exactGrade.records) ? exactGrade.records : [],
        label: `${exactCompany.company_name} ${exactGrade.grade_value}`,
        warning: null,
      };
    }
  }

  for (const group of gradedGroups) {
    const grade = Array.isArray(group?.grades)
      ? group.grades.find(
          (entry) => normalize(entry?.grade_value || "") === normalize(request.gradeValue || ""),
        )
      : null;
    if (grade) {
      return {
        records: Array.isArray(grade.records) ? grade.records : [],
        label: `${group.company_name} ${grade.grade_value}`,
        warning: `Exact ${request.label} grade not found. Using ${group.company_name} ${grade.grade_value} sales.`,
      };
    }
  }

  if (rawRecords.length) {
    return {
      records: rawRecords,
      label: "Raw",
      warning: `Exact ${request.label} grade not found. Using raw sales.`,
    };
  }

  return {
    records: [],
    label: request.label,
    warning: `No CardSight sales were available for ${request.label}.`,
  };
}

function filterCardSightCompMatches(comps = [], metadata = {}, parallel = null) {
  return comps.filter((comp) => {
    if (!metadata.parallel) return true;
    const parallelText = [comp?.parallelName, parallel?.name, comp?.title].filter(Boolean).join(" ");
    return parallelMatchesTitle(parallelText, metadata.parallel) || normalize(parallelText).includes(normalize(metadata.parallel));
  });
}

function scoreCardSightDetailedCandidate(result = {}, details = {}, metadata = {}, parallel = null) {
  const description = buildCardSightMatchDescription(result, details, parallel);
  let score = scoreCardSightSearchResult(result, metadata);
  if (matchesCoreCardIdentity(description, metadata)) score += 80;
  if (metadata.cardNumber) {
    const normalizedWanted = normalize(String(metadata.cardNumber || ""));
    const normalizedActual = normalize(String(details?.number || ""));
    if (normalizedActual && normalizedWanted) {
      if (normalizedActual === normalizedWanted) {
        score += 120;
      } else if (normalizedActual.includes(normalizedWanted) || normalizedWanted.includes(normalizedActual)) {
        score += 40;
      } else {
        score -= 80;
      }
    }
  }
  if (metadata.setName) {
    const normalizedSet = normalize(String(metadata.setName || ""));
    if (normalize(String(details?.releaseName || "")).includes(normalizedSet)) score += 40;
    if (normalize(String(details?.setName || "")).includes(normalizedSet)) score += 25;
  }
  return score;
}

function shouldUseCardSightImageLookup(metadata = {}) {
  const imageUrl = String(metadata.imageUrl || "").trim();
  if (!/^https?:\/\//i.test(imageUrl)) return false;
  const titleHint = cleanQueryText(metadata.titleHint || "");
  return !metadata.playerName || !metadata.setName || !metadata.cardNumber || titleHint.length < 20;
}

function buildCardSightDetectionItem(details = {}) {
  return {
    id: details?.id || details?.segmentId || details?.releaseId || details?.setId || null,
    name:
      details?.name ||
      details?.description ||
      [
        details?.year,
        details?.manufacturer,
        details?.releaseName,
        details?.setName,
        details?.number ? `#${details.number}` : null,
      ].filter(Boolean).join(" "),
    parallelName: details?.parallel?.name || "",
  };
}

function enrichMetadataFromCardSightDetails(metadata = {}, details = {}) {
  const attributes = Array.isArray(details?.attributes) ? details.attributes : [];
  const derivedSetName = [details?.releaseName, details?.setName].filter(Boolean).join(" ").trim();
  return {
    ...metadata,
    playerName: metadata.playerName || details?.name || "",
    year: metadata.year || details?.year || null,
    setName: metadata.setName || derivedSetName || "",
    cardNumber: metadata.cardNumber || details?.number || "",
    parallel: metadata.parallel || details?.parallel?.name || "",
    variantLabel: metadata.variantLabel || attributes.join(" "),
    rookieFlag: metadata.rookieFlag || attributes.some((value) => /\brookie\b/i.test(String(value || ""))),
    autographFlag:
      metadata.autographFlag ||
      attributes.some((value) => /\b(?:autograph|auto|signature|signed)\b/i.test(String(value || ""))),
  };
}

function scoreCardSightImageDetection(detection = {}, metadata = {}) {
  const details = detection?.card || {};
  const parallel = resolveCardSightParallel(details, metadata, details?.parallel?.name || "");
  const enrichedMetadata = enrichMetadataFromCardSightDetails(metadata, details);
  const item = buildCardSightDetectionItem(details);
  let score = scoreCardSightDetailedCandidate(item, details, enrichedMetadata, parallel);
  const confidence = String(detection?.confidence || "").trim().toLowerCase();
  if (confidence === "high") score += 180;
  if (confidence === "medium") score += 120;
  if (confidence === "low") score += 60;
  if (details?.id) score += 120;
  return {
    item,
    details,
    parallel,
    confidence: detection?.confidence || null,
    score,
  };
}

function inferCardSightImageFilename(imageUrl, contentType = "image/jpeg") {
  const extensionByType = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  const contentTypeKey = String(contentType || "").split(";")[0].trim().toLowerCase();
  try {
    const parsed = new URL(imageUrl);
    const lastSegment = parsed.pathname.split("/").filter(Boolean).pop() || "";
    if (lastSegment && /\.[a-z0-9]+$/i.test(lastSegment)) return lastSegment;
  } catch {
    // ignore malformed image URLs and fall back to a synthetic name
  }
  return `listing.${extensionByType[contentTypeKey] || "jpg"}`;
}

async function identifyCardSightCardFromImage(metadata = {}) {
  const imageUrl = String(metadata.imageUrl || "").trim();
  if (!/^https?:\/\//i.test(imageUrl)) {
    return {
      cardId: null,
      cardMatch: null,
      details: null,
      parallel: null,
    };
  }

  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) {
    throw new Error(`Listing image download failed (${imageResponse.status}).`);
  }
  const contentType = String(imageResponse.headers.get("content-type") || "image/jpeg")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!contentType.startsWith("image/")) {
    throw new Error("Listing image response was not an image.");
  }

  const bytes = await imageResponse.arrayBuffer();
  if (!bytes.byteLength) {
    throw new Error("Listing image response was empty.");
  }

  const formData = new FormData();
  formData.set(
    "image",
    new Blob([bytes], { type: contentType }),
    inferCardSightImageFilename(imageUrl, contentType),
  );

  const response = await callCardHedgeApi("/v1/identify/card", {
    method: "POST",
    body: formData,
  });
  const detections = Array.isArray(response?.detections) ? response.detections : [];
  const ranked = detections
    .map((detection) => scoreCardSightImageDetection(detection, metadata))
    .sort((a, b) => b.score - a.score || String(a.details?.name || "").localeCompare(String(b.details?.name || "")));
  const best = ranked[0];
  if (!best?.details) {
    return {
      cardId: null,
      cardMatch: null,
      details: null,
      parallel: null,
    };
  }

  const description = buildCardSightMatchDescription(best.item, best.details, best.parallel);
  return {
    query: imageUrl,
    cardId: best?.details?.id ? String(best.details.id) : null,
    cardMatch: {
      cardId: best?.details?.id ? String(best.details.id) : null,
      description,
      confidence: best.confidence,
      score: best.score,
      matchedVia: "image-ocr",
    },
    details: best.details,
    parallel: best.parallel,
  };
}

async function findCardSightCard(metadata = {}, { strictMatchMode = false } = {}) {
  let effectiveMetadata = { ...metadata };
  let imageMatch = null;
  if (shouldUseCardSightImageLookup(metadata)) {
    try {
      imageMatch = await identifyCardSightCardFromImage(metadata);
      if (imageMatch?.details) {
        effectiveMetadata = enrichMetadataFromCardSightDetails(metadata, imageMatch.details);
      }
      if (imageMatch?.cardId) {
        const description = String(imageMatch?.cardMatch?.description || "").trim();
        if (!strictMatchMode || strictCardHedgeDescriptionMatches(description, effectiveMetadata)) {
          return imageMatch;
        }
      }
    } catch {
      imageMatch = null;
    }
  }

  const queries = buildCardSightSearchQueries(effectiveMetadata);
  if (!queries.length) {
    return {
      query: "",
      cardId: imageMatch?.cardId || null,
      cardMatch: imageMatch?.cardMatch || null,
      details: imageMatch?.details || null,
      parallel: imageMatch?.parallel || null,
      ...(strictMatchMode && imageMatch?.cardId ? { rejectedByStrict: true } : {}),
    };
  }

  const results = [];
  for (const query of queries) {
    const searchResult = await callCardHedgeApi("/v1/catalog/search", {
      method: "GET",
      searchParams: {
        q: query,
        type: "card",
        take: 10,
        ...(effectiveMetadata.year ? { year: String(effectiveMetadata.year) } : {}),
      },
    });
    const rows = Array.isArray(searchResult?.results)
      ? searchResult.results.filter((item) => item?.type === "card")
      : [];
    results.push(...rows.map((item) => ({ ...item, _query: query })));
    if (results.length >= 10) break;
  }
  const ranked = results
    .map((item) => ({
      item,
      score: scoreCardSightSearchResult(item, effectiveMetadata),
    }))
    .sort((a, b) => b.score - a.score || String(a.item?.name || "").localeCompare(String(b.item?.name || "")));
  if (!ranked[0]?.item?.id) {
    return {
      query: queries[0] || "",
      cardId: null,
      cardMatch: null,
      details: null,
      parallel: null,
    };
  }

  const detailedCandidates = [];
  for (const entry of ranked.slice(0, 5)) {
    const details = await callCardHedgeApi(`/v1/catalog/cards/${entry.item.id}`, {
      method: "GET",
    });
    const parallel = resolveCardSightParallel(details, effectiveMetadata, entry.item.parallelName || "");
    detailedCandidates.push({
      item: entry.item,
      details,
      parallel,
      score: scoreCardSightDetailedCandidate(entry.item, details, effectiveMetadata, parallel),
    });
  }
  detailedCandidates.sort((a, b) => b.score - a.score || String(a.item?.name || "").localeCompare(String(b.item?.name || "")));
  const bestCandidate = detailedCandidates[0];
  const best = bestCandidate?.item || null;
  const details = bestCandidate?.details || null;
  const parallel = bestCandidate?.parallel || null;
  const description = buildCardSightMatchDescription(best, details, parallel);
  const cardMatch = {
    cardId: String(best.id),
    description,
    confidence: null,
    score: bestCandidate?.score ?? null,
    matchedVia: "catalog-search",
  };

  if (strictMatchMode && !strictCardHedgeDescriptionMatches(description, effectiveMetadata)) {
    return {
      query: best._query || queries[0] || "",
      cardId: null,
      cardMatch,
      details,
      parallel,
      rejectedByStrict: true,
    };
  }

  return {
    query: best._query || queries[0] || "",
    cardId: String(best.id),
    cardMatch,
    details,
    parallel,
  };
}

async function searchCardHedgeSoldListings(metadata = {}) {
  const cacheKey = buildCardHedgeCacheKey("sold_lookup", {
    metadata,
    grade: resolveCardHedgeCompGrade(metadata),
    strictMatchMode: isStrictCompMatchMode(metadata),
  });
  const cached = await readCardHedgeCacheEntry(cacheKey);
  if (cached) return cached;
  const config = getCardHedgeConfig();
  const query = buildCardHedgeQuery(metadata);
  const strictMatchMode = isStrictCompMatchMode(metadata);
  const requestedGrade = resolveCardHedgeCompGrade(metadata);
  if (!query) {
    return {
      source: "cardhedge",
      comps: [],
      importedCount: 0,
      rejectedCount: 0,
      sampleTitles: [],
      keywordsUsed: [],
      cardMatchWarning: strictMatchMode ? "Strict mode requires an exact CardSight card match." : null,
      pricingSummary: null,
    };
  }

  const match = await findCardSightCard(metadata, { strictMatchMode });
  const cardMatchSummary = match.cardMatch
    ? summarizeCardHedgeMatch(match.cardMatch, match.cardMatch.matchedVia || "catalog-search")
    : null;

  if (match.rejectedByStrict) {
    return {
      source: "cardhedge",
      comps: [],
      importedCount: 0,
      rejectedCount: 0,
      sampleTitles: [],
      keywordsUsed: [query],
      cardMatch: cardMatchSummary,
      cardMatchWarning: "Strict mode rejected the CardSight match because it was not an exact variant match.",
      pricingSummary: null,
    };
  }

  if (!match.cardId) {
    return {
      source: "cardhedge",
      comps: [],
      importedCount: 0,
      rejectedCount: 0,
      sampleTitles: [],
      keywordsUsed: [query],
      cardMatch: null,
      pricingSummary: null,
    };
  }

  const parallel = match.parallel || null;
  const rawPrices = await callCardHedgeApi(`/v1/pricing/${match.cardId}`, {
    method: "GET",
    searchParams: {
      listing_type: "both",
      limit: Math.max(1, clampPositiveInt(config.compsCount, 10, 100)),
      period: CARDSIGHT_PRICING_PERIOD,
      ...(parallel?.id === "null"
        ? { parallel_id: "null" }
        : parallel?.id
          ? { parallel_id: parallel.id }
          : {}),
    },
  });
  const selectedPricing = selectCardSightPricingSection(rawPrices, requestedGrade);

  const parsed = parseCardHedgeComps(
    Array.isArray(selectedPricing.records) ? selectedPricing.records : [],
    { sourceCardId: match.cardId },
  );
  const parsedComps = dedupeListings(
    parsed.sort(
      (a, b) => (b.matchScore - a.matchScore) || (b.totalPrice - a.totalPrice),
    ),
  );
  const metadataFilteredComps = filterCardSightCompMatches(parsedComps, metadata, parallel);
  const strictFilteredComps = strictMatchMode
    ? metadataFilteredComps.filter((comp) => strictCardHedgeDescriptionMatches(comp.title, metadata))
    : metadataFilteredComps;

  const result = {
    source: "cardhedge",
    comps: strictFilteredComps,
    importedCount: strictFilteredComps.length,
    rejectedCount: Math.max(0, parsedComps.length - strictFilteredComps.length),
    sampleTitles: strictFilteredComps.slice(0, 5).map((comp) => comp.title),
    keywordsUsed: [query],
    cardMatch: cardMatchSummary,
    pricingSummary: summarizeCardHedgePricingSummary(rawPrices, selectedPricing.label || requestedGrade),
    cardMatchWarning:
      [
        selectedPricing.warning,
        strictMatchMode && !strictFilteredComps.length
          ? "Strict mode found the card but rejected the available sales as non-exact comps."
          : null,
      ].filter(Boolean).join(" ") || null,
  };
  await writeCardHedgeCacheEntry({
    cacheKey,
    cacheType: "sold_lookup",
    payload: result,
    metadata: { query, requestedGrade, strictMatchMode },
  });
  return result;
}

export async function loadRecentCardHedgeSales(metadata = {}, { count = 8 } = {}) {
  const requestedCount = Math.min(Math.max(clampPositiveInt(count, 8, 20), 1), 20);
  const cacheKey = buildCardHedgeCacheKey("recent_sales", {
    metadata,
    count: requestedCount,
    grade: resolveCardHedgeCompGrade(metadata),
    strictMatchMode: isStrictCompMatchMode(metadata),
  });
  const cached = await readCardHedgeCacheEntry(cacheKey);
  if (cached) return cached;
  const query = buildCardHedgeQuery(metadata);
  const strictMatchMode = isStrictCompMatchMode(metadata);
  if (!query) {
    return {
      source: "cardhedge",
      sales: [],
      loadedCount: 0,
      cardMatch: null,
      cardMatchWarning: strictMatchMode ? "Strict mode requires an exact CardSight card match." : null,
    };
  }

  const match = await findCardSightCard(metadata, { strictMatchMode });
  const cardMatchSummary = match.cardMatch
    ? summarizeCardHedgeMatch(match.cardMatch, match.cardMatch.matchedVia || "catalog-search")
    : null;

  if (match.rejectedByStrict) {
    return {
      source: "cardhedge",
      sales: [],
      loadedCount: 0,
      cardMatch: cardMatchSummary,
      cardMatchWarning: "Strict mode rejected the CardSight match because it was not an exact variant match.",
    };
  }

  if (!match.cardId) {
    return {
      source: "cardhedge",
      sales: [],
      loadedCount: 0,
      cardMatch: null,
      cardMatchWarning: null,
    };
  }

  const requestedGrade = resolveCardHedgeCompGrade(metadata);
  const parallel = match.parallel || null;
  const rawPrices = await callCardHedgeApi(`/v1/pricing/${match.cardId}`, {
    method: "GET",
    searchParams: {
      listing_type: "both",
      limit: requestedCount,
      period: CARDSIGHT_PRICING_PERIOD,
      ...(parallel?.id === "null"
        ? { parallel_id: "null" }
        : parallel?.id
          ? { parallel_id: parallel.id }
          : {}),
    },
  });
  const selectedPricing = selectCardSightPricingSection(rawPrices, requestedGrade);
  const parsed = parseCardHedgeComps(
    Array.isArray(selectedPricing.records) ? selectedPricing.records : [],
    { sourceCardId: match.cardId },
  ).sort((a, b) => String(b.soldAt || "").localeCompare(String(a.soldAt || "")));

  const metadataFiltered = filterCardSightCompMatches(parsed, metadata, parallel);
  const recentSales = strictMatchMode
    ? metadataFiltered.filter((comp) => strictCardHedgeDescriptionMatches(comp.title, metadata))
    : metadataFiltered;
  const limitedRecentSales = recentSales.slice(0, requestedCount);

  const result = {
    source: "cardhedge",
    sales: limitedRecentSales,
    loadedCount: limitedRecentSales.length,
    cardMatch: cardMatchSummary,
    cardMatchWarning:
      [
        selectedPricing.warning,
        strictMatchMode && !limitedRecentSales.length
          ? "Strict mode found the card but rejected the available recent sales as non-exact comps."
          : null,
      ].filter(Boolean).join(" ") || null,
  };
  await writeCardHedgeCacheEntry({
    cacheKey,
    cacheType: "recent_sales",
    payload: result,
    metadata: { query, requestedCount, requestedGrade, strictMatchMode },
  });
  return result;
}

export async function searchApifySoldListings(metadata = {}) {
  const config = getApifyConfig();
  const provider = shouldForceApifyProvider(metadata) ? "apify" : getCompDataProvider();
  const requestedCount = resolveApifySoldCount(metadata);

  if (provider === "cardhedge") {
    try {
      return await searchCardHedgeSoldListings(metadata);
    } catch (error) {
      if (config.token && isCardHedgeApifyFallbackEnabled()) {
        console.warn("CardHedge comps lookup failed, falling back to Apify", error.message);
      } else {
        throw error;
      }
    }
  }

  if (!config.token) {
    throw new Error("Missing APIFY_TOKEN");
  }

  const keywords = buildApifyKeywords(metadata);
  if (!keywords.length) {
    return {
      source: "apify",
      comps: [],
      importedCount: 0,
      rejectedCount: 0,
      sampleTitles: [],
      keywordsUsed: [],
    };
  }

  const parsedRuns = [];
  const queryLimit = Math.min(
    keywords.length,
    metadata.baseHint || metadata.parallel || inferParallelHint(metadata) || metadata.autographFlag
      ? 2
      : 1,
  );
  const keywordsUsed = keywords.slice(0, queryLimit);

  for (const keyword of keywordsUsed) {
    const input = {
      keywords: [keyword],
      daysToScrape: config.daysToScrape,
      count: requestedCount,
      ebaySite: config.ebaySite,
      sortOrder: config.sortOrder,
      itemLocation: config.itemLocation,
      itemCondition: shouldForceApifyProvider(metadata) || metadata.gradedFlag ? "any" : "used",
    };

    const response = await fetch(
      `https://api.apify.com/v2/acts/${config.actorId}/run-sync-get-dataset-items?token=${encodeURIComponent(config.token)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(input),
      },
    );

    const payload = await response.json();
    if (!response.ok) {
      const message =
        payload?.error?.message || payload?.message || payload?.error || `HTTP ${response.status}`;
      throw new Error(`Apify sold listings request failed (${response.status}): ${message}`);
    }

    const items = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.items)
        ? payload.items
        : [];
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
      parallel: queryParallel,
    });
    parsedRuns.push(parsed);
  }

  const comps = dedupeListings(parsedRuns.flatMap((entry) => entry.comps)).sort(
    (a, b) => b.matchScore - a.matchScore || a.totalPrice - b.totalPrice,
  );
  const limit = requestedCount;
  const rejectedCount = parsedRuns.reduce((sum, entry) => sum + (entry.rejectedCount || 0), 0);
  return {
    source: "apify",
    comps: comps.slice(0, limit),
    importedCount: Math.min(comps.length, limit),
    rejectedCount,
    sampleTitles: comps.slice(0, 5).map((comp) => comp.title),
    keywordsUsed,
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
  if (
    metadata.parallel &&
    !parallelMatchesTitle(row.title || row.keyword || "", metadata.parallel)
  ) {
    return null;
  }
  const salePrice = toNumber(row.soldPrice);
  const shippingPrice = toNumber(row.shippingPrice);
  const totalPrice =
    toNumber(row.totalPrice) ?? (salePrice == null ? null : salePrice + (shippingPrice || 0));
  const score = scoreListing(row, metadata);
  if (score < thresholdForMetadata(metadata)) {
    return null;
  }

  return {
    source: "apify_sold_listings",
    listingId: String(
      row.itemId || row.url || `${row.title || "listing"}:${row.endedAt || row.scrapedAt || ""}`,
    ),
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
    rawPayload: row,
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

  comps.sort(
    (a, b) => (b.soldAt || "").localeCompare(a.soldAt || "") || a.totalPrice - b.totalPrice,
  );

  return {
    comps,
    importedCount: comps.length,
    rejectedCount: rejected.length,
    sampleTitles: comps.slice(0, 5).map((comp) => comp.title),
  };
}
