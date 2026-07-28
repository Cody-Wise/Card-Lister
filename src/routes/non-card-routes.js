// "Other items" panel — the store's non-card listings (apparel, jerseys,
// memorabilia) with individual and bulk repricing. These listings have no
// local cardItem, so everything here reads live from eBay and writes straight
// back to eBay; nothing is persisted into the card store. Peer extraction to
// the other src/routes/*.js files, not a wrapper around app.js.
import { sendJson, readJson } from "../lib/http.js";
import { withStateReadOnly } from "../lib/store.js";
import { fetchEbayActiveListings, updateEbayListingPrice } from "../services/ebay.js";
import {
  partitionListingsByCategory,
  summarizeByCategory,
  categoryLabel,
  planBulkReprice,
  minimumListingPrice,
} from "../services/non-card-listings.js";

// GetMyeBaySelling's daily call quota is already the account's tightest
// constraint (it has been exhausted twice by having several consumers each
// call it on their own schedule), so this panel caches the account-wide
// listing pull and reuses it rather than refetching on every page visit.
// An explicit refresh, and any successful reprice, invalidate it.
const CACHE_TTL_MS = Math.max(
  60 * 1000,
  (Number.parseInt(process.env.NON_CARD_CACHE_MINUTES || "15", 10) || 15) * 60 * 1000,
);
let cache = null; // { fetchedAt, nonCard, cardCount, unclassified }
let fetchInProgress = false;

function buildMinimalTrackedOffers(state) {
  const fromOffers = (Array.isArray(state.offers) ? state.offers : []).map((offer) => ({
    ebayOfferId: offer?.ebayOfferId || null,
    listingId: offer?.listingId || null,
    listingUrl: offer?.listingUrl || null,
    sku: offer?.sku || null,
    currentPrice: offer?.price ?? null,
  }));
  const fromCards = (Array.isArray(state.cardItems) ? state.cardItems : [])
    .filter((card) => card?.listingId || card?.listingUrl || card?.sku)
    .map((card) => ({
      ebayOfferId: card?.ebayOfferId || card?.offerId || null,
      listingId: card?.listingId || null,
      listingUrl: card?.listingUrl || null,
      sku: card?.sku || null,
      currentPrice: card?.recommendedPrice ?? null,
    }));
  return [...fromOffers, ...fromCards];
}

function toRow(listing) {
  return {
    listingId: listing?.listingId ? String(listing.listingId) : null,
    sku: listing?.sku || null,
    title: listing?.title || null,
    categoryId: listing?.categoryId || null,
    categoryLabel: categoryLabel(listing?.categoryId),
    currentPrice: Number.isFinite(Number(listing?.currentPrice)) ? Number(listing.currentPrice) : null,
    quantity: listing?.quantity ?? null,
    soldQuantity: listing?.soldQuantity ?? null,
    watchCount: listing?.watchCount ?? null,
    listedAt: listing?.listedAt || null,
    listingUrl: listing?.listingUrl || null,
    imageUrl: listing?.imageUrl || null,
    bestOfferEnabled: Boolean(listing?.bestOfferEnabled),
    format: listing?.format || "FIXED_PRICE",
  };
}

async function loadNonCardListings({ force = false } = {}) {
  const fresh = cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (fresh && !force) return { ...cache, cached: true };
  if (fetchInProgress) {
    if (cache) return { ...cache, cached: true };
    throw new Error("A listing refresh is already running. Try again in a moment.");
  }

  fetchInProgress = true;
  try {
    const trackedOffers = await withStateReadOnly(async (state) => buildMinimalTrackedOffers(state));
    // 200 x 10 covers the account's ~900 active listings with headroom; the
    // Trading leg stops early once eBay reports the last page.
    const listings = await fetchEbayActiveListings({
      offers: trackedOffers,
      pageSize: 200,
      maxPages: 10,
    });
    const { nonCard, card, unclassified } = partitionListingsByCategory(listings);
    cache = {
      fetchedAt: Date.now(),
      nonCard: nonCard.map(toRow),
      cardCount: card.length,
      unclassifiedCount: unclassified.length,
      totalActive: listings.length,
    };
    return { ...cache, cached: false };
  } finally {
    fetchInProgress = false;
  }
}

function parseAdjustment(body = {}) {
  const type = String(body?.adjustmentType || body?.adjustment?.type || "percent").toLowerCase();
  const rawValue = body?.adjustmentValue ?? body?.adjustment?.value;
  const value = Number(rawValue);
  if (!["percent", "amount", "fixed"].includes(type)) {
    throw new Error(`Unsupported adjustment type "${type}".`);
  }
  if (!Number.isFinite(value)) throw new Error("Adjustment value must be a number.");
  if (type === "percent" && value <= -100) throw new Error("A -100% or larger cut would zero the price.");
  if (type === "fixed" && value <= 0) throw new Error("A fixed price must be greater than 0.");
  return { type, value };
}

function parseBounds(body = {}) {
  const minRaw = Number(body?.minPrice);
  const maxRaw = Number(body?.maxPrice);
  const minPrice = Number.isFinite(minRaw) && minRaw > 0 ? minRaw : null;
  const maxPrice = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : null;
  if (minPrice && maxPrice && minPrice > maxPrice) {
    throw new Error("Minimum price cannot exceed maximum price.");
  }
  return { minPrice, maxPrice };
}

// The reprice routes never trust a client-supplied listing id on its own: ids
// are intersected with the server's own verified non-card set, so a stale tab
// or a malformed request can't push a bulk percentage change onto a card.
async function selectTargets(body = {}) {
  const snapshot = await loadNonCardListings();
  const byId = new Map(snapshot.nonCard.filter((row) => row.listingId).map((row) => [row.listingId, row]));

  const requestedIds = Array.isArray(body?.listingIds)
    ? body.listingIds.map((id) => String(id || "").trim()).filter(Boolean)
    : null;

  // Per-listing explicit prices: [{listingId, price}] — used by the
  // individual-edit path, where each row gets its own target price.
  const explicit = Array.isArray(body?.prices) ? body.prices : null;

  if (explicit) {
    const targets = [];
    const rejected = [];
    for (const entry of explicit) {
      const id = String(entry?.listingId || "").trim();
      const row = byId.get(id);
      if (!row) {
        rejected.push({ listingId: id || null, reason: "not_a_non_card_listing" });
        continue;
      }
      targets.push({ row, price: Number(entry?.price) });
    }
    return { snapshot, mode: "explicit", targets, rejected };
  }

  const rejected = [];
  let rows;
  if (requestedIds && requestedIds.length) {
    rows = [];
    for (const id of requestedIds) {
      const row = byId.get(id);
      if (row) rows.push(row);
      else rejected.push({ listingId: id, reason: "not_a_non_card_listing" });
    }
  } else {
    rows = snapshot.nonCard.filter((row) => row.listingId);
  }
  const categoryId = String(body?.categoryId || "").trim();
  if (categoryId) rows = rows.filter((row) => String(row.categoryId) === categoryId);

  return { snapshot, mode: "bulk", rows, rejected };
}

function buildPlan(body, selection) {
  if (selection.mode === "explicit") {
    const changes = [];
    const skipped = [];
    for (const { row, price } of selection.targets) {
      if (!Number.isFinite(price) || price <= 0) {
        skipped.push({ ...row, reason: "invalid_price" });
        continue;
      }
      const newPrice = Math.round((price + Number.EPSILON) * 100) / 100;
      if (newPrice < minimumListingPrice()) {
        skipped.push({ ...row, newPrice, reason: "below_minimum" });
        continue;
      }
      if (newPrice === row.currentPrice) {
        skipped.push({ ...row, newPrice, reason: "unchanged" });
        continue;
      }
      changes.push({
        listingId: row.listingId,
        sku: row.sku,
        title: row.title,
        categoryId: row.categoryId,
        currentPrice: row.currentPrice,
        newPrice,
        delta: Math.round((newPrice - (row.currentPrice || 0) + Number.EPSILON) * 100) / 100,
        deltaPercent: row.currentPrice
          ? Math.round(((newPrice - row.currentPrice) / row.currentPrice) * 10000) / 100
          : null,
        clamped: false,
      });
    }
    return { changes, skipped, totalCurrentValue: null, totalNewValue: null };
  }

  const adjustment = parseAdjustment(body);
  const { minPrice, maxPrice } = parseBounds(body);
  return planBulkReprice({ listings: selection.rows, adjustment, minPrice, maxPrice });
}

export async function handleNonCardApiRoutes(req, res, { pathname, url }) {
  if (req.method === "GET" && pathname === "/api/non-card-listings") {
    try {
      const force = url?.searchParams?.get("refresh") === "1";
      const snapshot = await loadNonCardListings({ force });
      sendJson(res, 200, {
        listings: snapshot.nonCard,
        summary: summarizeByCategory(snapshot.nonCard),
        cardCount: snapshot.cardCount,
        unclassifiedCount: snapshot.unclassifiedCount,
        totalActive: snapshot.totalActive,
        fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
        cached: snapshot.cached,
        minPrice: minimumListingPrice(),
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/api/non-card-listings/preview") {
    try {
      const body = await readJson(req);
      const selection = await selectTargets(body);
      const plan = buildPlan(body, selection);
      sendJson(res, 200, { ...plan, rejected: selection.rejected });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/api/non-card-listings/reprice") {
    try {
      const body = await readJson(req);
      const selection = await selectTargets(body);
      const plan = buildPlan(body, selection);

      if (!plan.changes.length) {
        sendJson(res, 200, {
          updated: 0,
          failed: 0,
          results: [],
          skipped: plan.skipped,
          rejected: selection.rejected,
        });
        return true;
      }

      const results = [];
      let updated = 0;
      let failed = 0;
      for (const change of plan.changes) {
        try {
          await updateEbayListingPrice({
            listingId: change.listingId,
            sku: change.sku,
            format: "FIXED_PRICE",
            price: change.newPrice,
          });
          updated += 1;
          results.push({ ...change, status: "updated" });
        } catch (error) {
          failed += 1;
          results.push({ ...change, status: "failed", error: error.message });
        }
      }

      // Prices just moved, so the cached snapshot is stale by definition.
      cache = null;

      sendJson(res, 200, {
        updated,
        failed,
        results,
        skipped: plan.skipped,
        rejected: selection.rejected,
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  return false;
}
