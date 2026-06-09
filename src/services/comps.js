import { activeListings, soldComps } from "../data/seed.js";
import { searchEbayListings } from "./ebay-browse.js";

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function matchesCard(comp, canonicalCard) {
  if (!canonicalCard) return false;
  return comp.cardId === canonicalCard.id;
}

export function getSoldComps(canonicalCard) {
  return soldComps
    .filter((comp) => matchesCard(comp, canonicalCard))
    .map((comp) => ({ ...comp, kind: "sold" }))
    .sort((a, b) => b.soldAt.localeCompare(a.soldAt));
}

export function getActiveListings(canonicalCard) {
  return activeListings
    .filter((listing) => matchesCard(listing, canonicalCard))
    .map((listing) => ({ ...listing, kind: "active" }));
}

export function getCardComps(canonicalCard) {
  return {
    sold: getSoldComps(canonicalCard),
    active: getActiveListings(canonicalCard)
  };
}

export async function getLiveCardComps(metadata = {}, frontImagePath = null, backImagePath = null, canonicalCard = null, manualSoldComps = []) {
  const local = canonicalCard ? getCardComps(canonicalCard) : { sold: [], active: [] };
  const manual = Array.isArray(manualSoldComps) ? manualSoldComps : [];
  if (canonicalCard && local.sold.length >= 3 && local.active.length >= 1) {
    return {
      sold: [...manual, ...local.sold],
      active: local.active
    };
  }
  const liveActive = await searchEbayListings({ metadata, frontImagePath, backImagePath });
  return {
    sold: [...manual, ...local.sold],
    active: [...local.active, ...liveActive]
  };
}

export function summarizeCompText(canonicalCard, comps) {
  if (!canonicalCard) return "No canonical card match yet.";
  const sold = comps.sold.length;
  const active = comps.active.length;
  return `${sold} sold comps and ${active} active listings found for ${canonicalCard.playerName} ${canonicalCard.year} ${canonicalCard.setName} ${canonicalCard.cardNumber}.`;
}
