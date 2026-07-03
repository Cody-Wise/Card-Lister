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
// through several generations — CardHedge and an in-progress "CardSight"
// rename that was never deployed (both fully removed — the account was
// dropped in favor of a SoldComps plan upgrade) -> an Apify actor
// (caffein.dev~ebay-sold-listings, scraping eBay's own sold-listings pages —
// APIFY_TOKEN and the actor call now power ONLY the separate market-heat
// feature, see getApifyMarketHeatReport) -> SoldComps (api.sold-comps.com, a
// direct, documented eBay-sold-listings API — the sole provider for
// per-card sold comps; see getSoldCompsConfig()/hasApifyConfig()).
// Function/variable names below still carry the "Apify" branding from
// before that swap (searchApifySoldListings, hasApifyConfig, etc.) even
// though they call SoldComps — deliberately NOT doing a mechanical rename of
// those identifiers in the same change as the provider swap; that's better
// done alongside splitting this file up (see README's "Known rough edges" /
// src/app.js size) so a provider-behavior change and a pure rename aren't
// bundled into one diff.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const marketHeatCachePath = path.join(rootDir, "data", "market-heat-cache.json");
const MARKET_HEAT_REFRESH_MS = Number(
  process.env.MARKET_HEAT_REFRESH_MS || 7 * 24 * 60 * 60 * 1000,
);
const MARKET_HEAT_DEFAULT_SAMPLE_SIZE = Number(process.env.APIFY_MARKET_HEAT_SAMPLE_SIZE || 500);
const MARKET_HEAT_DEFAULT_LIMIT = Number(process.env.MARKET_HEAT_DEFAULT_LIMIT || 50);
const SOLD_COMP_CACHE_VERSION = String(process.env.SOLD_COMP_CACHE_VERSION || "v3").trim() || "v3";
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

// Market-heat only now — per-card sold-comp lookups use SoldComps below.
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

const SOLD_COMPS_BASE_URL = "https://api.sold-comps.com";

// SoldComps (api.sold-comps.com) — direct eBay-sold-listings API, the sole
// provider for per-card sold-comp search (CardHedge was fully removed after
// upgrading the SoldComps plan). Falls back to the corresponding
// APIFY_EBAY_* value above for any tuning knob left blank here.
function getSoldCompsConfig() {
  return {
    apiKey: process.env.SOLDCOMPS_API_KEY || "",
    daysToScrape: clampPositiveInt(
      Number(process.env.SOLDCOMPS_DAYS_TO_SCRAPE || process.env.APIFY_EBAY_SOLD_DAYS_TO_SCRAPE || 60),
      1,
      365,
    ),
    ebaySite: process.env.SOLDCOMPS_EBAY_SITE || process.env.APIFY_EBAY_SITE || "ebay.com",
    sortOrder: process.env.SOLDCOMPS_SORT_ORDER || process.env.APIFY_EBAY_SORT_ORDER || "endedRecently",
    itemLocation: process.env.SOLDCOMPS_ITEM_LOCATION || process.env.APIFY_EBAY_ITEM_LOCATION || "default",
    categoryId: process.env.SOLDCOMPS_CATEGORY_ID || "0",
  };
}

// SoldComps' free tier caps out at 100 requests/month (separate from its
// 60/min rate limit). This app doesn't know what plan is active, so it
// tracks its own conservative monthly budget locally and fails clearly
// before actually hitting the provider's quota and getting 403s on every
// subsequent lookup for the rest of the billing cycle.
// Overridable via SOLDCOMPS_USAGE_FILE so tests can point this at an
// isolated temp file — Node's test runner runs separate *.test.js files
// concurrently by default, and this file is real shared local state, not
// something a backup/restore hook alone can safely serialize across files.
function soldCompsUsagePath() {
  return process.env.SOLDCOMPS_USAGE_FILE || path.join(rootDir, "data", "soldcomps-usage.json");
}

function currentUsageMonth() {
  return new Date().toISOString().slice(0, 7); // "YYYY-MM"
}

function soldCompsMonthlyLimit() {
  const parsed = Number(process.env.SOLDCOMPS_MONTHLY_REQUEST_LIMIT);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90;
}

async function loadSoldCompsUsage() {
  try {
    const raw = await fs.readFile(soldCompsUsagePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.month === currentUsageMonth()) {
      return { month: parsed.month, count: Number(parsed.count) || 0 };
    }
  } catch {
    // No usage file yet, or it's unreadable — start a fresh month.
  }
  return { month: currentUsageMonth(), count: 0 };
}

async function saveSoldCompsUsage(usage) {
  await fs.mkdir(path.dirname(soldCompsUsagePath()), { recursive: true });
  await fs.writeFile(soldCompsUsagePath(), JSON.stringify(usage, null, 2));
}

async function hasSoldCompsBudget() {
  const usage = await loadSoldCompsUsage();
  return usage.count < soldCompsMonthlyLimit();
}

async function recordSoldCompsRequest() {
  const usage = await loadSoldCompsUsage();
  usage.count += 1;
  await saveSoldCompsUsage(usage);
  return usage;
}

// Exported for the health endpoint / manual inspection — not used in the
// request path itself.
export async function getSoldCompsUsageStatus() {
  const usage = await loadSoldCompsUsage();
  const limit = soldCompsMonthlyLimit();
  return { month: usage.month, count: usage.count, limit, remaining: Math.max(0, limit - usage.count) };
}

// Was named shouldForceApifyProvider back when it also chose between
// CardHedge/Apify as sold-comp providers; now there's only one provider
// (SoldComps), so its only remaining job is deciding whether a search
// should include both new/used condition (trading cards, non-sport cards)
// instead of just "used".
function isTradingCardMetadata(metadata = {}) {
  const explicit = String(metadata.compDataProvider || metadata.provider || "").toLowerCase().trim();
  if (explicit === "apify" || explicit === "soldcomps") return true;
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
    Number(process.env.SOLDCOMPS_COUNT || process.env.APIFY_EBAY_SOLD_COUNT || 10),
    10,
    100,
  );
  return isTradingCardMetadata(metadata) ? Math.max(configuredCount, 15) : configuredCount;
}

// Always "apify" now — kept as a function (rather than inlining the
// literal) since it's still a meaningful cache-key input if this ever grows
// a second market-heat data source again.
function getMarketHeatProvider() {
  return "apify";
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

function cacheExpiryIso(ttlMs) {
  return Number.isFinite(ttlMs) && ttlMs > 0 ? new Date(Date.now() + ttlMs).toISOString() : null;
}

function cacheEntryFresh(entry) {
  const expiresAt = Date.parse(String(entry?.expiresAt || ""));
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt > Date.now();
}

async function readSharedCacheEntry(cacheKey) {
  if (!hasSupabaseConfig()) return null;
  try {
    const entry = await getCacheEntry(cacheKey);
    if (!entry || !cacheEntryFresh(entry)) return null;
    return entry.payload || null;
  } catch {
    return null;
  }
}

async function writeSharedCacheEntry({
  cacheKey,
  cacheType,
  payload,
  metadata = null,
  ttlMs = 24 * 60 * 60 * 1000,
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

  let snapshot = await readSharedCacheEntry(cacheKey);
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
    await writeSharedCacheEntry({
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

// Name kept as-is (see naming note at top of file) — checks whether the
// sold-comp provider (SoldComps) is configured.
export function hasApifyConfig() {
  return Boolean(getSoldCompsConfig().apiKey);
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
    "soldcomps",
    SOLD_COMP_CACHE_VERSION,
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

// Name kept as-is (see naming note at top of file) — this calls SoldComps
// (api.sold-comps.com) rather than the old Apify actor. The item shape
// SoldComps returns (itemId/title/condition/soldPrice/shippingPrice/
// totalPrice/endedAt/url/sellerUsername/sellerPositivePercent/
// sellerFeedbackScore) matches what parseApifySoldListings/
// normalizeSoldListing already expect closely enough that no changes were
// needed there — only the HTTP call and its config are new.
export async function searchApifySoldListings(metadata = {}) {
  const config = getSoldCompsConfig();
  const requestedCount = resolveApifySoldCount(metadata);

  if (!config.apiKey) {
    throw new Error("Missing SOLDCOMPS_API_KEY");
  }

  if (!(await hasSoldCompsBudget())) {
    const limit = soldCompsMonthlyLimit();
    throw new Error(
      `SoldComps monthly request budget (${limit}) reached for this billing cycle — raise SOLDCOMPS_MONTHLY_REQUEST_LIMIT if you're on a higher-quota plan.`,
    );
  }

  const keywords = buildApifyKeywords(metadata);
  if (!keywords.length) {
    return {
      source: "soldcomps",
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
    const params = new URLSearchParams({
      keyword,
      daysToScrape: String(config.daysToScrape),
      count: String(requestedCount),
      ebaySite: config.ebaySite,
      sortOrder: config.sortOrder,
      itemLocation: config.itemLocation,
      itemCondition: isTradingCardMetadata(metadata) || metadata.gradedFlag ? "any" : "used",
      categoryId: config.categoryId,
    });

    const response = await fetch(`${SOLD_COMPS_BASE_URL}/v1/scrape?${params.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "application/json",
      },
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        payload?.error?.message || payload?.message || payload?.error || `HTTP ${response.status}`;
      throw new Error(`SoldComps sold listings request failed (${response.status}): ${message}`);
    }
    // Count this against the monthly budget only once we know the request
    // itself succeeded.
    await recordSoldCompsRequest();

    const items = Array.isArray(payload?.items) ? payload.items : [];
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
    source: "soldcomps",
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
