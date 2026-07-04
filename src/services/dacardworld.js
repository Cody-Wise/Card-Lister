// Watches https://www.dacardworld.com/ for current new releases and
// sales/deals, once a day (see DACARDWORLD_WATCH_INTERVAL_MINUTES in
// src/server.js). The whole site sits behind a Cloudflare JS challenge —
// confirmed directly: plain fetch()/curl gets a challenge page, not real
// content, on every page including /robots.txt's referenced sitemap. A real
// browser gets through fine, so this uses Playwright with CapSolver's
// browser extension loaded (the user's existing CapSolver subscription)
// rather than a paid scraping API. Once past the challenge, the HTML itself
// is plain server-rendered markup — no client-side hydration to fight.
//
// Selector tuning note: the CSS selectors below were determined from a
// single research pass over real rendered pages, not verified end-to-end
// against a live CapSolver-solved run (that requires the real API key,
// which only exists in production — see the deploy smoke test). If a
// refresh comes back with zero items for a section, that's the first thing
// to check: dump page.content() from a failed run and re-tune the selector
// for whichever template changed.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cachePath = path.join(rootDir, "data", "dacardworld-cache.json");
const userDataDir = path.join(rootDir, "data", "dacardworld-browser-profile");

// Baked into the Docker image at build time (see Dockerfile) — not
// downloaded at runtime, so a flaky GitHub release fetch can't break a
// production restart.
const EXTENSION_DIR = process.env.CAPSOLVER_EXTENSION_DIR || path.join(rootDir, "capsolver-extension");

const TARGET_URLS = {
  newReleases: "https://www.dacardworld.com/sports-cards/new-sports-card-releases",
  dailyDeals: "https://www.dacardworld.com/daily-deals/",
  bestPrices: "https://www.dacardworld.com/sports-cards/best-prices",
};

const NAVIGATION_TIMEOUT_MS = Math.max(
  10_000,
  Number.parseInt(process.env.DACARDWORLD_NAVIGATION_TIMEOUT_MS || "45000", 10) || 45000,
);
// Cloudflare's challenge (and CapSolver solving it) takes real time after
// the page "loads" — this is separate from navigation timeout above.
const CHALLENGE_SETTLE_MS = Math.max(
  1000,
  Number.parseInt(process.env.DACARDWORLD_CHALLENGE_SETTLE_MS || "12000", 10) || 12000,
);

export function hasDaCardWorldConfig() {
  return Boolean(process.env.CAPSOLVER_API_KEY);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The extension's own config format (assets/config.js inside the unzipped
// release) is a plain ES module exporting `defaultConfig` with an
// `apiKey: ''` field — patched here from our own env var at launch time so
// the real secret never gets baked into the Docker image or committed
// anywhere. Idempotent/safe to call before every launch.
async function ensureExtensionApiKey() {
  const configPath = path.join(EXTENSION_DIR, "assets", "config.js");
  const raw = await fs.readFile(configPath, "utf8");
  const apiKey = process.env.CAPSOLVER_API_KEY || "";
  const patched = raw.replace(/apiKey:\s*'[^']*'/, `apiKey: '${apiKey}'`);
  if (patched !== raw) {
    await fs.writeFile(configPath, patched);
  }
}

async function launchBrowserContext() {
  const { chromium } = await import("playwright");
  await ensureExtensionApiKey();
  await fs.mkdir(userDataDir, { recursive: true });
  // Persistent profile (not a fresh incognito context each run) so
  // Cloudflare's clearance cookie can carry over between daily runs —
  // solving the challenge fresh every single day is slower and spends more
  // CapSolver credits than it needs to.
  return chromium.launchPersistentContext(userDataDir, {
    // Confirmed directly against a real run: Chromium's headless mode
    // (even the newer "headless=new" implementation) never actually loads
    // the extension's Manifest V3 service worker at all — context
    // .serviceWorkers() stayed empty for the full run, so CapSolver never
    // got a chance to solve anything. Extensions need a real ("headed")
    // browser; see the Dockerfile for the Xvfb virtual-display wrapper
    // (xvfb-run) that makes that possible on a server with no real display.
    headless: false,
    viewport: { width: 1920, height: 1080 },
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      "--lang=en-US",
    ],
  });
}

async function openChallengeCleared(context, url) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
  // Give Cloudflare's challenge (and the CapSolver extension solving it)
  // time to settle before we start reading content.
  await sleep(CHALLENGE_SETTLE_MS);
  return page;
}

// Raw extraction for the "classic" Foundation-grid template (new releases,
// best prices): repeating <li class="text-center"> under a ul.item-grid,
// with .item-title a for title+url, .product-icons-new for a literal "New"
// badge, and .item-pricing-small for price (strong.price = current/sale
// price, span.price.discount = crossed-out original when discounted).
async function extractClassicGridRows(page) {
  return page.$$eval("ul.item-grid li, ul.small-block-grid li, ul.block-grid li", (nodes) =>
    nodes
      .map((node) => {
        const titleLink = node.querySelector(".item-title a") || node.querySelector("a[href]");
        if (!titleLink) return null;
        const priceEl = node.querySelector(".item-pricing-small strong.price, strong.price");
        const discountEl = node.querySelector(".item-pricing-small span.price.discount, span.price.discount");
        return {
          title: titleLink.textContent.trim(),
          href: titleLink.getAttribute("href") || "",
          priceText: priceEl ? priceEl.textContent.trim() : "",
          discountPriceText: discountEl ? discountEl.textContent.trim() : "",
          isNew: Boolean(node.querySelector(".product-icons-new")),
        };
      })
      .filter(Boolean),
  );
}

// Raw extraction for the Tailwind-based deals template (daily-deals):
// repeating <li class="list-none">, .item-title for the name, one-or-more
// .item-select-item blocks per product (each a purchasable variant like
// "Box" vs "8-Box Case"). Link markup for this template wasn't confirmed
// during research (the captured snippet didn't show one) — falls back to
// the first anchor found anywhere in the list item.
async function extractDealsRows(page) {
  return page.$$eval("li.list-none, li:has(.item-select)", (nodes) =>
    nodes
      .map((node) => {
        const titleEl = node.querySelector(".item-title");
        if (!titleEl) return null;
        const link = node.querySelector("a[href]");
        const priceEl = node.querySelector(".item-select-item strong.price, strong.price");
        const discountEl = node.querySelector(".item-select-item span.price.discount, span.price.discount");
        return {
          title: titleEl.textContent.trim(),
          href: link ? link.getAttribute("href") || "" : "",
          priceText: priceEl ? priceEl.textContent.trim() : "",
          discountPriceText: discountEl ? discountEl.textContent.trim() : "",
          isNew: false,
        };
      })
      .filter(Boolean),
  );
}

// Pure, unit-testable: "$1,234.56" -> 1234.56. Returns null for unparsable
// input rather than 0, so a genuinely-missing price doesn't look like a
// free item.
export function parsePriceText(text) {
  if (!text) return null;
  const match = String(text).match(/[\d,]+\.?\d*/);
  if (!match) return null;
  const value = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

// Pure, unit-testable: resolves a relative href against the site root, and
// leaves an already-absolute URL untouched.
export function resolveDaCardWorldUrl(href) {
  if (!href) return null;
  try {
    return new URL(href, "https://www.dacardworld.com/").toString();
  } catch {
    return null;
  }
}

// Pure, unit-testable: raw extracted row -> normalized listing entry.
// Returns null for rows with no usable title or URL, rather than a
// half-populated entry the UI would render as a dead/blank link.
export function normalizeListing(raw = {}) {
  const title = String(raw.title || "").trim();
  const url = resolveDaCardWorldUrl(raw.href);
  if (!title || !url) return null;
  const price = parsePriceText(raw.priceText);
  const originalPrice = parsePriceText(raw.discountPriceText);
  return {
    title,
    url,
    price,
    originalPrice: originalPrice && price != null && originalPrice > price ? originalPrice : null,
    isNew: Boolean(raw.isNew),
  };
}

// Pure, unit-testable: dedupes by URL, keeping the first occurrence (a
// product can legitimately appear more than once across pages, e.g. a new
// release that's also currently discounted).
export function dedupeListings(listings = []) {
  const seen = new Set();
  const unique = [];
  for (const item of listings) {
    if (!item || !item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    unique.push(item);
  }
  return unique;
}

async function scrapeSection(context, url, extractor) {
  const page = await openChallengeCleared(context, url);
  try {
    const rawRows = await extractor(page);
    return dedupeListings(rawRows.map((row) => normalizeListing(row)).filter(Boolean));
  } finally {
    await page.close().catch(() => {});
  }
}

export async function refreshDaCardWorldWatch() {
  if (!hasDaCardWorldConfig()) {
    throw new Error("Missing CAPSOLVER_API_KEY");
  }

  const context = await launchBrowserContext();
  try {
    const [newReleases, dailyDeals, bestPrices] = await Promise.all([
      scrapeSection(context, TARGET_URLS.newReleases, extractClassicGridRows),
      scrapeSection(context, TARGET_URLS.dailyDeals, extractDealsRows),
      scrapeSection(context, TARGET_URLS.bestPrices, extractClassicGridRows),
    ]);

    const snapshot = {
      generatedAt: new Date().toISOString(),
      newReleases,
      // Daily deals + best prices are the same "promos/sales" category (the
      // site doesn't have a distinct promotions page) — combined and
      // deduped since a card can appear on both.
      deals: dedupeListings([...dailyDeals, ...bestPrices]),
    };
    await saveSnapshot(snapshot);
    return snapshot;
  } finally {
    await context.close().catch(() => {});
  }
}

async function saveSnapshot(snapshot) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(snapshot, null, 2));
}

export async function getDaCardWorldSnapshot() {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return { generatedAt: null, newReleases: [], deals: [] };
  }
}
