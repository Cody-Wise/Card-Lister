// Scheduled eBay order sync: fetches recent orders and marks matching cards
// and offers "sold" by SKU/listing/title. This is the same fetch-and-apply
// logic used by GET /api/ebay/sales?sync=1 (src/app.js), factored out so it
// can also run on a timer without needing an HTTP request. Deliberately does
// NOT rebuild the month/sport sales report that route also returns — a
// scheduler only needs to apply sold status, not render a UI aggregation.
import { fetchEbayFulfillmentOrders, normalizeOrderDate, normalizeOrderLineDate } from "../services/ebay.js";
import {
  resolveCardFromSalesLine,
  applySoldSaleToCard,
  applySoldSaleToOffer,
  detectSalePriceAnomaly,
  lineItemSku,
  lineItemListingId,
  lineItemDisplayName,
  lineItemTotal,
  lineItemQuantity,
  extractEbayListingId,
  cardTitleCandidates,
} from "../app.js";
import { createAuditEvent, withState } from "../lib/store.js";

function buildLookupMaps(state) {
  const cardById = new Map((state.cardItems || []).map((card) => [card.id, card]));
  const cards = Array.isArray(state.cardItems) ? state.cardItems : [];
  const cardBySku = new Map();
  const cardByListingId = new Map();
  const cardByTitle = new Map();
  const offerBySku = new Map();
  const offerByListingId = new Map();

  for (const offer of state.offers || []) {
    if (offer?.sku) offerBySku.set(String(offer.sku), offer);
    const offerListingId = offer?.listingId || extractEbayListingId(offer?.listingUrl);
    if (offerListingId) offerByListingId.set(String(offerListingId), offer);
    if (offer?.sku && offer?.cardItemId) cardBySku.set(String(offer.sku), offer.cardItemId);
    if (offerListingId && offer?.cardItemId) cardByListingId.set(String(offerListingId), offer.cardItemId);
  }
  for (const card of cards) {
    if (card?.sku) cardBySku.set(String(card.sku), card.id);
    const cardListingId = card?.listingId || extractEbayListingId(card?.listingUrl);
    if (cardListingId) cardByListingId.set(String(cardListingId), card.id);
    for (const candidate of cardTitleCandidates(card)) {
      if (!cardByTitle.has(candidate)) cardByTitle.set(candidate, card.id);
    }
  }

  return { cardById, cards, cardBySku, cardByListingId, cardByTitle, offerBySku, offerByListingId };
}

// Fetches recent orders, matches each sold line item to a card, and applies
// sold status to matching cards/offers. Returns a summary; only writes an
// audit event when something actually changed.
export async function syncEbaySales({ days = 30 } = {}) {
  const result = await fetchEbayFulfillmentOrders({ days });

  return withState(async (state) => {
    const { cardById, cards, cardBySku, cardByListingId, cardByTitle, offerBySku, offerByListingId } =
      buildLookupMaps(state);

    let matchedLines = 0;
    const matchedSalesByCardId = new Map();

    for (const order of result.orders || []) {
      const items = Array.isArray(order.lineItems) ? order.lineItems : [];
      for (const item of items) {
        const soldAt = normalizeOrderLineDate(order, item) || normalizeOrderDate(order);
        const quantity = lineItemQuantity(item.quantity);
        const totalLinePrice = lineItemTotal(item, quantity);
        const sku = lineItemSku(item);
        const orderId = order.orderId || order.order_id || order.orderNumber || null;
        const listingId = lineItemListingId(item);

        const resolvedCard = resolveCardFromSalesLine({
          cardById,
          cardBySku,
          cardByListingId,
          cardByTitle,
          cards,
          sku,
          listingId,
          itemUrl: null,
          title: lineItemDisplayName(item),
        });
        if (!resolvedCard) continue;
        matchedLines += 1;

        const existingSale = matchedSalesByCardId.get(resolvedCard.id) || {
          soldAt: null,
          quantity: 0,
          totalAmount: 0,
          unitPrice: null,
          orderId: null,
          listingId: null,
          itemUrl: null,
        };
        existingSale.quantity += quantity;
        existingSale.totalAmount += totalLinePrice || 0;
        if (!existingSale.soldAt || (soldAt && soldAt > existingSale.soldAt)) {
          existingSale.soldAt = soldAt || existingSale.soldAt;
          existingSale.orderId = orderId;
          existingSale.listingId = listingId;
        }
        matchedSalesByCardId.set(resolvedCard.id, existingSale);
      }
    }

    let updatedCards = 0;
    let updatedOffers = 0;
    for (const [cardId, sale] of matchedSalesByCardId.entries()) {
      const card = cardById.get(cardId);
      if (!card) continue;
      const wasAlreadySold = card.status === "sold";
      if (applySoldSaleToCard(card, sale)) {
        updatedCards += 1;
        if (!wasAlreadySold) {
          const anomaly = detectSalePriceAnomaly(card, card.soldPrice);
          if (anomaly) {
            card.saleAnomaly = anomaly;
            createAuditEvent(state, "cardItem", card.id, "sale_price_anomaly", anomaly);
          }
        }
      }
      const offer =
        (sale.listingId ? offerByListingId.get(String(sale.listingId)) : null) ||
        (card.sku ? offerBySku.get(String(card.sku)) : null) ||
        null;
      if (offer && applySoldSaleToOffer(offer, sale)) updatedOffers += 1;
    }

    const summary = {
      totalOrders: result.orders?.length || 0,
      matchedLines,
      updatedCards,
      updatedOffers,
    };

    if (updatedCards || updatedOffers) {
      createAuditEvent(state, "ebay_sales", "sync", "scheduled_sync", summary);
    }

    return summary;
  });
}
