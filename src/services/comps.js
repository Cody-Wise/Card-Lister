import { searchEbayListings, searchEbaySoldListings } from "./ebay-browse.js";
import { searchApifySoldListings, hasApifyConfig } from "./apify.js";
import { searchEbaySoldScraperListings, hasEbaySoldScraperConfig } from "./ebay-sold-scraper.js";

// Bounded wrapper for the Apify attempt inside the auto provider chain —
// without this, a hung Apify actor run (the exact failure mode that
// prompted building the scraper, 2026-07-24) would eat the caller's whole
// timeout budget and the scraper fallback would never get its turn.
async function withProviderTimeout(promise, ms) {
  let timeoutId = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Apify sold-comps attempt timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export function hasSoldCompsProvider() {
  return hasApifyConfig() || hasEbaySoldScraperConfig();
}

// Provider chain for sold comps. SOLD_COMPS_PROVIDER:
//   "auto" (default) — Apify first (bounded), scraper on failure/timeout
//   "apify"          — Apify only (old behavior)
//   "scraper"        — scraper only (e.g. while Apify's actor is broken)
// Both providers return the same contract ({source, comps, importedCount,
// rejectedCount, sampleTitles, keywordsUsed}) and run the same
// normalization/gating (parseApifySoldListings), so callers don't care
// which one answered.
export async function searchSoldListings(metadata = {}) {
  const provider = String(process.env.SOLD_COMPS_PROVIDER || "auto").toLowerCase();
  if (provider === "scraper") return searchEbaySoldScraperListings(metadata);
  if (provider === "apify") return searchApifySoldListings(metadata);
  if (hasApifyConfig()) {
    const apifyTimeoutMs = Math.max(
      1000,
      Number.parseInt(process.env.SOLD_COMPS_APIFY_TIMEOUT_MS, 10) || 20000,
    );
    try {
      return await withProviderTimeout(searchApifySoldListings(metadata), apifyTimeoutMs);
    } catch (error) {
      if (!hasEbaySoldScraperConfig()) throw error;
      console.warn(`[sold-comps] Apify failed (${error.message}) — falling back to the eBay scraper`);
      return searchEbaySoldScraperListings(metadata);
    }
  }
  if (hasEbaySoldScraperConfig()) return searchEbaySoldScraperListings(metadata);
  throw new Error("No sold-comps provider available (Apify unconfigured, scraper disabled)");
}

function dedupeComps(comps = []) {
  const seen = new Set();
  const unique = [];
  for (const comp of Array.isArray(comps) ? comps : []) {
    const key =
      comp?.listingId ||
      comp?.url ||
      `${String(comp?.title || "").toLowerCase()}:${comp?.soldAt || ""}:${comp?.totalPrice || ""}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(comp);
  }
  return unique;
}

export async function getLiveCardComps(
  metadata = {},
  frontImagePath = null,
  backImagePath = null,
  _canonicalCard = null,
  manualSoldComps = [],
  imageUrl = null,
  allowApify = true,
) {
  const manual = Array.isArray(manualSoldComps) ? manualSoldComps : [];
  const liveActive = await searchEbayListings({ metadata, frontImagePath, backImagePath, imageUrl });
  if (manual.length) {
    return {
      sold: dedupeComps(manual),
      active: liveActive,
    };
  }
  // allowApify: false (the scheduled repricer, src/jobs/reprice-scheduler.js)
  // means never trigger a metered lookup of any kind from this unattended
  // job — no billed Apify run, and no residential-proxy scrape either
  // (DataImpulse bills per GB, so the scraper is also real money at
  // repricer scale: every repriceable card, every 360-minute tick). It
  // keeps the old eBay-native sold search, which is effectively inert
  // since eBay decommissioned findCompletedItems. Every other caller
  // (initial pipeline processing, manual reprice/review actions, Best
  // Offers scan) goes through the full provider chain.
  const soldSource = allowApify && hasSoldCompsProvider()
    ? await searchSoldListings(metadata)
    : {
        comps: await searchEbaySoldListings({
          metadata,
          frontImagePath,
          backImagePath,
          imageUrl,
          matchedListings: liveActive,
        }),
      };
  return {
    sold: dedupeComps([...(Array.isArray(soldSource.comps) ? soldSource.comps : []), ...manual]),
    active: liveActive,
  };
}
