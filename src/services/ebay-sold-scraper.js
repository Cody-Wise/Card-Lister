// Scrapes eBay's PUBLIC sold-listings search (ebay.com/sch with
// LH_Sold=1&LH_Complete=1 — no login, no session, no seller account
// involved) as a sold-comps provider. Built 2026-07-25 while the Apify
// actor this app normally uses (caffein.dev~ebay-sold-listings) was down
// with a provider-side bug; this is the same underlying data source that
// actor scrapes, fetched with our own Playwright stack instead.
//
// Deliberate reuse over reinvention:
//   - Keywords come from buildApifyKeywords (apify.js) — same identity
//     gate (no player/set anchor -> no query) and same query text as the
//     Apify path, so search behavior is comparable across providers.
//   - Raw rows are shaped to match the Apify actor's item shape and fed
//     through parseApifySoldListings (apify.js), so every relevance gate,
//     parallel/rookie/autograph check, lot-penalty, and match score is
//     IDENTICAL to the Apify path. A comp from this scraper meets exactly
//     the same bar as a comp from the actor.
//
// Browser/proxy stack mirrors dacardworld.js (the existing Playwright
// consumer in this repo): headed chromium under the Dockerfile's Xvfb
// wrapper, persistent profile so cookies carry between runs, and a
// residential proxy (DataImpulse). Proxy creds come from
// EBAY_SCRAPER_PROXY_* when set, else fall back to the DACARDWORLD_PROXY_*
// values already provisioned on the server — same provider, no new
// secrets. Unlike dacardworld there's no CapSolver extension here: eBay's
// public search doesn't sit behind Cloudflare, and the failure mode is a
// plain challenge page we detect and surface as an error instead.
//
// Proxy bandwidth is billed per GB, so the context blocks
// images/media/fonts/stylesheets — the listings data is all in the HTML.
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApifyKeywords, parseApifySoldListings } from "./apify.js";
import { inferParallelHint } from "../lib/card-query.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const userDataDir = process.env.EBAY_SCRAPER_PROFILE_DIR || path.join(rootDir, "data", "ebay-scraper-profile");

const NAVIGATION_TIMEOUT_MS = Math.max(
  5000,
  Number.parseInt(process.env.EBAY_SCRAPER_NAVIGATION_TIMEOUT_MS, 10) || 45000,
);
// Idle window after which the browser context is closed to free memory —
// scrapes are bursty (a batch of cards, then nothing for hours).
const IDLE_CLOSE_MS = 5 * 60 * 1000;

// OFF by default. Confirmed live 2026-07-26: eBay blocks this scrape from
// every route tried — datacenter IP gets /splashui/captcha ("Security
// Measure"), DataImpulse residential exits get a soft "Something went
// wrong on our end" error page, and both can redirect to signin.ebay.com.
// The detection is on the automated-browser fingerprint, not the IP, so
// rotating exits doesn't help. The module is kept (parsers are tested, the
// provider chain is wired) so it can be switched on if a fingerprint/
// challenge-solving approach is added later — but until then, leaving it
// enabled would mean every card lookup pays a ~15s blocked round trip.
export function hasEbaySoldScraperConfig() {
  return process.env.EBAY_SOLD_SCRAPER === "1" || process.env.EBAY_SOLD_SCRAPER === "true";
}

function getProxyConfig() {
  const server = process.env.EBAY_SCRAPER_PROXY_SERVER || process.env.DACARDWORLD_PROXY_SERVER || "";
  if (!server) return undefined;
  return {
    server,
    username:
      process.env.EBAY_SCRAPER_PROXY_USERNAME || process.env.DACARDWORLD_PROXY_USERNAME || undefined,
    password:
      process.env.EBAY_SCRAPER_PROXY_PASSWORD || process.env.DACARDWORLD_PROXY_PASSWORD || undefined,
  };
}

// ---------------------------------------------------------------------------
// Pure text parsers — exported for tests. eBay's sold-search markup renders
// these as human-facing strings; each parser tolerates the observed
// variants and returns null (never throws) on anything unrecognized.
// ---------------------------------------------------------------------------

// "$2.89", "$1,234.56", "$2.89 to $5.00" (price-range rows take the low
// bound — a range means a multi-variation listing, and the low bound is the
// conservative comp read).
export function parseEbayPriceText(text) {
  const match = /\$\s*([\d,]+(?:\.\d{1,2})?)/.exec(String(text || ""));
  if (!match) return null;
  const value = Number(match[1].replaceAll(",", ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

// "+$4.99 delivery", "+$4.99 shipping", "Free shipping", "Free delivery",
// "Shipping not specified". Free -> 0; unknown/unspecified -> null.
export function parseEbayShippingText(text) {
  const raw = String(text || "").toLowerCase();
  if (!raw.trim()) return null;
  if (raw.includes("free")) return 0;
  const match = /\+?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/.exec(raw);
  if (!match) return null;
  const value = Number(match[1].replaceAll(",", ""));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// "Sold Oct 12, 2025" (sometimes doubled whitespace, sometimes prefixed
// with extra text) -> ISO string at UTC midnight, matching the Apify
// actor's endedAt date-only precision.
export function parseEbaySoldDateText(text) {
  const match = /sold\s+([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(String(text || ""));
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  if (month === undefined) return null;
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// "/itm/376661333183?..." or full URL -> "376661333183"
export function parseEbayItemIdFromUrl(url) {
  const match = /\/itm\/(\d{9,15})/.exec(String(url || ""));
  return match ? match[1] : null;
}

// Maps one scraped row (raw strings straight off the page) onto the exact
// item shape the Apify actor emits, so parseApifySoldListings treats both
// sources identically. Returns null for rows with no usable title/price —
// eBay pads results with "Shop on eBay" placeholder cells.
export function toApifyShapedRow(scraped, keyword) {
  const title = String(scraped?.title || "").trim();
  if (!title || /^shop on ebay$/i.test(title)) return null;
  const soldPrice = parseEbayPriceText(scraped?.priceText);
  if (!Number.isFinite(soldPrice) || soldPrice <= 0) return null;
  const shippingPrice = parseEbayShippingText(scraped?.shippingText);
  const endedAt = parseEbaySoldDateText(scraped?.soldDateText);
  const url = String(scraped?.url || "").split("?")[0] || null;
  const itemId = parseEbayItemIdFromUrl(scraped?.url);
  const bodyText = String(scraped?.bodyText || "").toLowerCase();
  return {
    title,
    keyword,
    itemId,
    url,
    endedAt,
    soldPrice: soldPrice.toFixed(2),
    shippingPrice: shippingPrice == null ? null : shippingPrice.toFixed(2),
    totalPrice: (soldPrice + (shippingPrice || 0)).toFixed(2),
    listingType: /\bbids?\b/.test(bodyText) ? "auction" : "buy_it_now",
    isBestOfferAccepted: bodyText.includes("best offer accepted"),
    condition: String(scraped?.conditionText || "").trim() || null,
    scrapedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Browser lifecycle — one persistent context, lazily launched, serialized
// access, closed after IDLE_CLOSE_MS of inactivity.
// ---------------------------------------------------------------------------

let contextPromise = null;
let idleCloseTimer = null;
let queueTail = Promise.resolve();

async function getContext() {
  if (!contextPromise) {
    contextPromise = (async () => {
      const { chromium } = await import("playwright");
      await fs.mkdir(userDataDir, { recursive: true });
      const context = await chromium.launchPersistentContext(userDataDir, {
        // Headed under Xvfb (see Dockerfile) — same reasoning as
        // dacardworld.js: a real browser fingerprint, not headless's.
        headless: false,
        viewport: { width: 1366, height: 900 },
        proxy: getProxyConfig(),
        args: ["--lang=en-US"],
      });
      // The sold data is server-rendered HTML — every image/font/style
      // byte fetched through the residential proxy is billed waste.
      await context.route("**/*", (route) => {
        const type = route.request().resourceType();
        if (type === "image" || type === "media" || type === "font" || type === "stylesheet") {
          return route.abort();
        }
        return route.continue();
      });
      return context;
    })();
    contextPromise.catch(() => {
      contextPromise = null;
    });
  }
  return contextPromise;
}

function scheduleIdleClose() {
  if (idleCloseTimer) clearTimeout(idleCloseTimer);
  idleCloseTimer = setTimeout(async () => {
    const pending = contextPromise;
    contextPromise = null;
    if (pending) {
      try {
        const context = await pending;
        await context.close();
      } catch {
        // Already dead — nothing to release.
      }
    }
  }, IDLE_CLOSE_MS);
  idleCloseTimer.unref?.();
}

function buildSearchUrl(keyword) {
  const url = new URL("https://www.ebay.com/sch/i.html");
  url.searchParams.set("_nkw", keyword);
  url.searchParams.set("LH_Sold", "1");
  url.searchParams.set("LH_Complete", "1");
  // Ended recently first — same ordering the Apify actor was configured
  // with (APIFY_EBAY_SORT_ORDER=endedRecently).
  url.searchParams.set("_sop", "13");
  url.searchParams.set("_ipg", "60");
  // US-located items only, matching APIFY_EBAY_ITEM_LOCATION=domestic.
  url.searchParams.set("LH_PrefLoc", "1");
  return url.toString();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function scrapeKeywordOnce(keyword) {
  const context = await getContext();
  const page = await context.newPage();
  try {
    await page.goto(buildSearchUrl(keyword), {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    // Classic markup is li.s-item; eBay has been rolling out an s-card
    // variant — accept either, and give slow proxy routes a beat to settle.
    const found = await page
      .waitForSelector("li.s-item, li.s-card, .s-item__title, .s-card__title", { timeout: 12000 })
      .then(() => true)
      .catch(() => false);
    if (!found) {
      const pageTitle = (await page.title().catch(() => "")) || "";
      const landedUrl = page.url();
      const bodyProbe = ((await page.textContent("body").catch(() => "")) || "").slice(0, 400);
      const haystack = `${pageTitle} ${bodyProbe}`;
      // Every observed block form must THROW, never return [] — a silent
      // empty result gets cached as "this card legitimately has no comps"
      // (apifyNoCompsFound, 24h cooldown), which is far worse than a loud
      // failure. Confirmed live 2026-07-26 against all three of these:
      //   - datacenter IP  -> /splashui/captcha, "Security Measure | eBay"
      //   - residential    -> "Error Page | eBay", "Something went wrong on
      //                       our end" (a soft block, NOT a real 5xx)
      //   - either         -> redirect to signin.ebay.com
      // The original regex here matched none of those strings, so the very
      // first live run reported a clean "0 comps" while fully blocked.
      const blockedByUrl = /splashui\/(challenge|captcha)|signin\.ebay\.com/i.test(landedUrl);
      const blockedByContent =
        /pardon|verify|denied|robot|captcha|challenge|security measure|error page|something went wrong/i.test(
          haystack,
        );
      if (blockedByUrl || blockedByContent) {
        throw new Error(
          `eBay blocked the sold-search scrape for "${keyword}" (landed on ${landedUrl.slice(0, 120)}) — automated-browser detection, not an empty result`,
        );
      }
      // Genuinely no results and no block signal: eBay renders a "0 results"
      // page with none of our row selectors. Safe to report as empty.
      const looksEmpty = /0 results|no exact matches|didn't match any/i.test(haystack);
      if (looksEmpty) return [];
      // Unrecognized page with no block signal and no empty-result signal —
      // could be a markup change. Fail loudly rather than silently pricing
      // a card off nothing.
      throw new Error(
        `eBay sold-search returned an unrecognized page for "${keyword}" (title: "${pageTitle.slice(0, 80)}") — selectors may be stale`,
      );
    }
    const rows = await page.$$eval("li.s-item, li.s-card", (nodes) =>
      nodes.map((node) => {
        const pick = (selectors) => {
          for (const selector of selectors) {
            const el = node.querySelector(selector);
            if (el && el.textContent && el.textContent.trim()) return el.textContent.trim();
          }
          return "";
        };
        const link =
          node.querySelector("a.s-item__link, a.su-link, a[href*='/itm/']")?.getAttribute("href") || "";
        return {
          title: pick([".s-item__title", ".s-card__title", "[role='heading']"]),
          priceText: pick([".s-item__price", ".s-card__price"]),
          shippingText: pick([".s-item__shipping", ".s-item__logisticsCost", ".s-card__shipping"]),
          soldDateText: pick([
            ".s-item__caption--signal",
            ".s-item__caption",
            ".s-item__title--tag",
            ".s-card__caption",
            ".POSITIVE",
          ]),
          conditionText: pick([".s-item__subtitle .SECONDARY_INFO", ".s-item__subtitle", ".s-card__subtitle"]),
          url: link,
          bodyText: (node.textContent || "").slice(0, 500),
        };
      }),
    );
    return rows;
  } finally {
    await page.close().catch(() => {});
  }
}

// Public entrypoint — same return contract as searchApifySoldListings so
// callers can treat the two providers interchangeably.
export async function searchEbaySoldScraperListings(metadata = {}) {
  if (!hasEbaySoldScraperConfig()) {
    throw new Error("The eBay sold scraper is disabled (EBAY_SOLD_SCRAPER=0)");
  }
  const keywords = buildApifyKeywords(metadata);
  if (!keywords.length) {
    return {
      source: "ebay_scraper",
      comps: [],
      importedCount: 0,
      rejectedCount: 0,
      sampleTitles: [],
      keywordsUsed: [],
    };
  }
  // Same query budget rule as searchApifySoldListings: a second, parallel-
  // specific query only when there's a variant to disambiguate.
  const queryLimit = Math.min(
    keywords.length,
    metadata.baseHint || metadata.parallel || inferParallelHint(metadata) || metadata.autographFlag ? 2 : 1,
  );
  const keywordsUsed = keywords.slice(0, queryLimit);

  // Serialize ALL scrapes process-wide (not just within one call) — a batch
  // of cards processing concurrently must not fan out into parallel page
  // loads through the same proxy exit; that pattern is exactly what
  // bot-detection keys on.
  const run = queueTail.then(async () => {
    const allRows = [];
    for (const [index, keyword] of keywordsUsed.entries()) {
      if (index > 0) await sleep(1200 + Math.floor(Math.random() * 1800));
      const scraped = await scrapeKeywordOnce(keyword);
      for (const row of scraped) {
        const shaped = toApifyShapedRow(row, keyword);
        if (shaped) allRows.push(shaped);
      }
    }
    return allRows;
  });
  // The shared tail must swallow this run's error so one blocked scrape
  // doesn't poison every queued call after it.
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );

  try {
    const allRows = await run;
    const parsed = parseApifySoldListings(allRows, metadata);
    return {
      source: "ebay_scraper",
      comps: parsed.comps,
      importedCount: parsed.importedCount,
      rejectedCount: parsed.rejectedCount,
      sampleTitles: parsed.sampleTitles,
      keywordsUsed,
    };
  } finally {
    scheduleIdleClose();
  }
}
