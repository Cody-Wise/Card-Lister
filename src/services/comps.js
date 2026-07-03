import { searchEbayListings, searchEbaySoldListings } from "./ebay-browse.js";
import { searchApifySoldListings, hasApifyConfig } from "./apify.js";

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
) {
  const manual = Array.isArray(manualSoldComps) ? manualSoldComps : [];
  const liveActive = await searchEbayListings({ metadata, frontImagePath, backImagePath, imageUrl });
  if (manual.length) {
    return {
      sold: dedupeComps(manual),
      active: liveActive,
    };
  }
  // Previously gated to TCG/non-sport metadata only, falling back to eBay's
  // own sold-listings search for every other (i.e. most) cards — broadened
  // 2026-07-03 at the user's request, since Apify is the more accurate
  // provider and this path (manual reprice, the repricing scheduler) was
  // quietly the one place still not using it for regular sports cards.
  const soldSource = hasApifyConfig()
    ? await searchApifySoldListings(metadata)
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
