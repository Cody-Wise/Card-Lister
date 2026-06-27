import { searchEbayListings, searchEbaySoldListings } from "./ebay-browse.js";

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
  const ebaySold = await searchEbaySoldListings({
    metadata,
    frontImagePath,
    backImagePath,
    imageUrl,
    matchedListings: liveActive,
  });
  return {
    sold: dedupeComps([...ebaySold, ...manual]),
    active: liveActive,
  };
}
