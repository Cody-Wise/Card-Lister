import { searchEbayListings, searchEbaySoldListings } from "./ebay-browse.js";
import { searchApifySoldListings, hasApifyConfig } from "./apify.js";
import { searchSoldCompsListings, hasSoldCompsApiConfig } from "./soldcomps.js";
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

// Sold-comp provider selection. SOLD_COMPS_PROVIDER:
//   "off" (DEFAULT) — no sold-comp lookups at all
//   "soldcomps"     — api.sold-comps.com (PREFERRED, and what production runs)
//   "apify"         — the Apify actor
//   "scraper"       — the Playwright eBay scraper
//   unset + keys    — SoldComps first (bounded), Apify on failure
//
// The CODE default stays "off" so no deployment starts spending on Apify by
// accident — opting in is an explicit env decision.
//
// History, because the reasoning has now reversed twice:
//   2026-07-26  Switched off. The Apify actor was unreliable (a 12+ minute
//               hang in production, plus a week of runaway billing), and the
//               Playwright scraper could not work at all because eBay had put
//               sold/completed listings behind sign-in (controlled test in
//               ebay-sold-scraper.js). Pricing fell back to ACTIVE listings.
//   2026-07-30  Sold comps came back. First re-enabled via "apify"; switched
//               the same day to "soldcomps" (api.sold-comps.com), which reaches
//               the same data with the same item schema but on a flat monthly
//               request quota instead of per-run billing. The actor returns real
//               completed sales once more — verified live: 15 comps with real
//               sale dates and real eBay item URLs, in ~4.7s, no login. So the
//               sign-in wall is not a barrier for this actor's technique.
//               calculatePrice() was always sold-comp-first; it was starved,
//               not broken. Two things had to be undone as well: 55 cards
//               carried an apifyNoCompsFound flag recorded against the DEAD
//               actor (false negatives that would have skipped lookups
//               forever), and the manual filename anchor was clamping prices
//               — it now steps aside once there are enough real sold comps
//               (see applyManualPriceAnchor).
//
// The scraper remains unusable; "auto" is still only worth it if a working
// fallback ever appears.
function soldCompsProvider() {
  return String(process.env.SOLD_COMPS_PROVIDER || "off").toLowerCase();
}

export function isSoldCompsDisabled() {
  const provider = soldCompsProvider();
  return provider === "off" || provider === "none" || provider === "disabled";
}

export function hasSoldCompsProvider() {
  if (isSoldCompsDisabled()) return false;
  return hasSoldCompsApiConfig() || hasApifyConfig() || hasEbaySoldScraperConfig();
}

// Both providers return the same contract ({source, comps, importedCount,
// rejectedCount, sampleTitles, keywordsUsed}) and run the same
// normalization/gating (parseApifySoldListings), so callers don't care
// which one answered — including the disabled case, which returns an empty
// result rather than throwing. Callers already treat "no sold comps" as a
// normal outcome, so this degrades cleanly to active-listing pricing.
export async function searchSoldListings(metadata = {}) {
  const provider = soldCompsProvider();
  if (isSoldCompsDisabled()) {
    return {
      source: "disabled",
      comps: [],
      importedCount: 0,
      rejectedCount: 0,
      sampleTitles: [],
      keywordsUsed: [],
    };
  }
  if (provider === "scraper") return searchEbaySoldScraperListings(metadata);
  if (provider === "apify") return searchApifySoldListings(metadata);
  // The SoldComps API is the preferred provider: same underlying data and the
  // same item schema as the Apify actor, but billed as a flat monthly request
  // quota instead of per run.
  if (provider === "soldcomps") return searchSoldCompsListings(metadata);
  if (hasSoldCompsApiConfig()) {
    const soldCompsTimeoutMs = Math.max(
      1000,
      Number.parseInt(process.env.SOLD_COMPS_API_TIMEOUT_MS, 10) || 25000,
    );
    try {
      return await withProviderTimeout(searchSoldCompsListings(metadata), soldCompsTimeoutMs);
    } catch (error) {
      if (!hasApifyConfig()) throw error;
      console.warn(`[sold-comps] SoldComps failed (${error.message}) — falling back to the Apify actor`);
      return searchApifySoldListings(metadata);
    }
  }
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
  // When sold comps are switched off entirely there's nothing to fall back
  // to: the eBay-native path below calls findCompletedItems, which eBay
  // decommissioned, so it's a guaranteed-empty round trip. Skip it rather
  // than spend a request proving that every time.
  // A sold-comp PROVIDER OUTAGE MUST NOT FAIL THE CARD.
  //
  // Learned the hard way: on 2026-10-09/10 api.sold-comps.com was down and 13
  // cards in batch_0048 came out status="failed" with processingError
  // "SoldComps did not respond". Nothing was wrong with those cards — images,
  // OCR and active listings were all fine — the comp provider was simply
  // unreachable, and that threw straight out of here into markCardFailed().
  //
  // The provider is consulted TWICE per card: computeCardResult calls
  // searchSoldListings itself inside a try/catch (recording cardItem.apifyError
  // and continuing), and then calls this function, which called it AGAIN with no
  // guard. So the guarded attempt degraded exactly as intended and the unguarded
  // one immediately after it killed the card anyway.
  //
  // Catching here rather than at each call site is deliberate: every caller
  // (pipeline processing, manual reprice, review actions, the Best Offers scan)
  // already treats "no sold comps" as a normal outcome and falls back to
  // active-listing pricing, which is what the comment above promises. Verified
  // against the real failure: with this in place the same input returns 14
  // active listings instead of throwing. soldError is returned so callers can
  // surface WHY comps are missing rather than silently showing none.
  let soldSource = { comps: [] };
  let soldError = null;
  try {
    soldSource = isSoldCompsDisabled()
      ? { comps: [] }
      : allowApify && hasSoldCompsProvider()
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
  } catch (error) {
    soldError = error?.message || String(error);
    console.warn(`[comps] sold-comp lookup failed, pricing from active listings instead: ${soldError}`);
  }
  return {
    sold: dedupeComps([...(Array.isArray(soldSource.comps) ? soldSource.comps : []), ...manual]),
    active: liveActive,
    soldError,
  };
}
