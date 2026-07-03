import { searchEbayListings, searchEbaySoldListings } from "./ebay-browse.js";
import { searchApifySoldListings } from "./apify.js";

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

function shouldUseApifySoldComps(metadata = {}) {
  const haystack = String(
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
  )
    .toLowerCase()
    .trim();
  if (!haystack) return false;
  return (
    haystack.includes("trading cards") ||
    /\b(pokemon|pok[eé]mon|magic|mtg|yugioh|yu gi oh|lorcana|one piece|digimon|star wars|marvel|dc|non sport|non-sport)\b/.test(
      haystack,
    )
  );
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
  const soldSource = shouldUseApifySoldComps(metadata)
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
