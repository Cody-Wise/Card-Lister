// "Other items" — everything in the eBay store that is NOT a trading card:
// team apparel, jerseys, memorabilia, and anything else listed alongside the
// cards. These never go through the OCR/identify pipeline, so the lister has
// no local cardItem for them; this panel works directly off live eBay listing
// data and pushes price revisions straight back to eBay.
//
// Pure functions only — no eBay I/O, no state access — so the classification
// and the bulk-reprice math are testable without a network or a store.

// Card categories, as seen on the live account (2026-07-28):
//   261328 Sports Trading Card Singles   (1034 listings)
//   183454 CCG Individual Cards            (30 listings)
//   183050 Non-Sport Trading Card Singles   (2 listings)
//   261329 Sports Trading Card Lots         (3 listings)
// 261329 is treated as a card category because it is still a Sports Cards
// category, which is exactly what this panel is defined to exclude. Override
// with the CARD_CATEGORY_IDS env var if card lots should be repriced here.
export const DEFAULT_CARD_CATEGORY_IDS = ["261328", "183454", "183050", "261329"];

// Human labels for the non-card categories actually present on the account.
// eBay files fan apparel by league/team, so a single "shirts and jerseys"
// group is spread across many category IDs — this is display sugar only;
// classification never depends on it.
export const CATEGORY_LABELS = {
  206: "Football-NFL Fan Apparel",
  2888: "Soccer Fan Apparel",
  15687: "Football-NFL Fan Apparel",
  24410: "Baseball-MLB Fan Apparel",
  24510: "Hockey-NHL Fan Apparel",
  24541: "College-NCAA Fan Apparel",
  155183: "College-NCAA Fan Apparel",
  261328: "Sports Trading Card Singles",
  261329: "Sports Trading Card Lots",
  183454: "CCG Individual Cards",
  183050: "Non-Sport Trading Card Singles",
};

export function normalizeCategoryId(value) {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) ? text : null;
}

export function categoryLabel(categoryId) {
  const id = normalizeCategoryId(categoryId);
  if (!id) return "Unknown category";
  return CATEGORY_LABELS[id] || `Category ${id}`;
}

export function cardCategoryIds() {
  const raw = String(process.env.CARD_CATEGORY_IDS || "").trim();
  if (!raw) return new Set(DEFAULT_CARD_CATEGORY_IDS);
  const ids = raw
    .split(",")
    .map((value) => normalizeCategoryId(value))
    .filter(Boolean);
  return ids.length ? new Set(ids) : new Set(DEFAULT_CARD_CATEGORY_IDS);
}

export function isCardCategory(categoryId) {
  const id = normalizeCategoryId(categoryId);
  return id ? cardCategoryIds().has(id) : false;
}

// A listing whose category could not be determined is deliberately NOT counted
// as non-card. Getting this backwards would sweep ~900 cards into a panel whose
// whole purpose is bulk price changes, so "unknown" fails closed and is instead
// reported separately as `unclassified` for follow-up.
export function isNonCardListing(listing = {}) {
  const id = normalizeCategoryId(listing?.categoryId);
  if (!id) return false;
  return !isCardCategory(id);
}

export function partitionListingsByCategory(listings = []) {
  const rows = Array.isArray(listings) ? listings : [];
  const nonCard = [];
  const card = [];
  const unclassified = [];
  for (const listing of rows) {
    const id = normalizeCategoryId(listing?.categoryId);
    if (!id) unclassified.push(listing);
    else if (isCardCategory(id)) card.push(listing);
    else nonCard.push(listing);
  }
  return { nonCard, card, unclassified };
}

export function summarizeByCategory(listings = []) {
  const counts = new Map();
  for (const listing of Array.isArray(listings) ? listings : []) {
    const id = normalizeCategoryId(listing?.categoryId) || "unknown";
    const bucket = counts.get(id) || { categoryId: id, label: categoryLabel(id), count: 0, totalValue: 0 };
    bucket.count += 1;
    const price = Number(listing?.currentPrice);
    if (Number.isFinite(price) && price > 0) bucket.totalValue = round2(bucket.totalValue + price);
    counts.set(id, bucket);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function minimumListingPrice() {
  const parsed = Number(process.env.NON_CARD_MIN_PRICE);
  return Number.isFinite(parsed) && parsed > 0 ? round2(parsed) : 0.99;
}

// adjustment: { type: "percent" | "amount" | "fixed", value: number }
//   percent -> currentPrice * (1 + value/100)   (value may be negative)
//   amount  -> currentPrice + value             (value may be negative)
//   fixed   -> value                            (ignores currentPrice)
export function computeAdjustedPrice(currentPrice, adjustment = {}) {
  const type = String(adjustment?.type || "percent").toLowerCase();
  const value = Number(adjustment?.value);
  if (!Number.isFinite(value)) return null;

  if (type === "fixed") return value > 0 ? round2(value) : null;

  const current = Number(currentPrice);
  if (!Number.isFinite(current) || current <= 0) return null;

  if (type === "percent") {
    // -100% or worse would zero/invert the price; reject rather than clamping
    // silently to the floor, which would look like a successful reprice.
    if (value <= -100) return null;
    return round2(current * (1 + value / 100));
  }
  if (type === "amount") return round2(current + value);
  return null;
}

export function clampListingPrice(price, { minPrice = null, maxPrice = null } = {}) {
  const value = Number(price);
  if (!Number.isFinite(value)) return null;
  const floor = Number.isFinite(Number(minPrice)) && Number(minPrice) > 0
    ? round2(Number(minPrice))
    : minimumListingPrice();
  let next = Math.max(floor, value);
  const ceiling = Number(maxPrice);
  if (Number.isFinite(ceiling) && ceiling > 0) next = Math.min(ceiling, next);
  return round2(next);
}

// Builds the full change set WITHOUT touching eBay, so the UI can show an exact
// preview of every price move and the caller can apply the same plan verbatim.
export function planBulkReprice({ listings = [], adjustment = {}, minPrice = null, maxPrice = null } = {}) {
  const changes = [];
  const skipped = [];

  for (const listing of Array.isArray(listings) ? listings : []) {
    const listingId = listing?.listingId ? String(listing.listingId) : null;
    const currentPrice = Number(listing?.currentPrice);
    const base = {
      listingId,
      sku: listing?.sku || null,
      title: listing?.title || null,
      categoryId: normalizeCategoryId(listing?.categoryId),
      currentPrice: Number.isFinite(currentPrice) ? round2(currentPrice) : null,
    };

    if (!listingId) {
      skipped.push({ ...base, reason: "no_listing_id" });
      continue;
    }
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      skipped.push({ ...base, reason: "no_current_price" });
      continue;
    }

    const raw = computeAdjustedPrice(currentPrice, adjustment);
    if (raw === null) {
      skipped.push({ ...base, reason: "invalid_adjustment" });
      continue;
    }

    const newPrice = clampListingPrice(raw, { minPrice, maxPrice });
    if (newPrice === null || newPrice <= 0) {
      skipped.push({ ...base, reason: "invalid_adjustment" });
      continue;
    }
    if (newPrice === base.currentPrice) {
      skipped.push({ ...base, newPrice, reason: "unchanged" });
      continue;
    }

    changes.push({
      ...base,
      newPrice,
      delta: round2(newPrice - base.currentPrice),
      deltaPercent: round2(((newPrice - base.currentPrice) / base.currentPrice) * 100),
      clamped: newPrice !== round2(raw),
    });
  }

  return {
    changes,
    skipped,
    totalCurrentValue: round2(changes.reduce((sum, row) => sum + row.currentPrice, 0)),
    totalNewValue: round2(changes.reduce((sum, row) => sum + row.newPrice, 0)),
  };
}
