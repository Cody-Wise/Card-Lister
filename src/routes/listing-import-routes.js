// Imports eBay active listings that have no local cardItem/offer record yet
// (created outside this app's own publish flow, or whose local record was
// lost) so the repricer, Best Offers scan, and sales analytics — which all
// key off cardItems, not raw eBay listings — can see them too. Peer
// extraction to the other src/routes/*.js files, not a wrapper around
// app.js (this file deliberately does its own lightweight card/listing
// matching rather than importing app.js's resolveCardFromSalesLine, to
// avoid a circular import between app.js and routes/).
import { sendJson } from "../lib/http.js";
import { createAuditEvent, createId, nowIso, withState, withStateReadOnly } from "../lib/store.js";
import { fetchEbayActiveListings } from "../services/ebay.js";
import { inferMetadataFromTitle } from "../jobs/pipeline.js";

// Guards against a double-click launching two overlapping imports (same
// convention as dacardworld-routes.js's refreshInProgress).
let importInProgress = false;

function normalizeMoney(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function normalizeTitleKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Trimmed to just the fields fetchEbayActiveListings actually reads off an
// input offer (see normalizeActiveListing in services/ebay.js) — not the
// full display shape app.js's buildTrackedOffersFromCards builds, which
// also carries image/format/status fields this call doesn't need.
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

// A listing counts as "already tracked" if a local card matches by sku,
// listingId, or an exact (normalized) title — deliberately not the full
// fuzzy scoreCardTitleMatch app.js uses for reconciling sales line items
// against a possibly-reformatted order-API title, since here we're
// comparing a listing's own title against a card's own stored ebayTitle,
// which either matches exactly or isn't linked at all.
function findExistingCardId({ cardBySku, cardByListingId, cardByTitle }, listing) {
  if (listing.sku && cardBySku.has(String(listing.sku))) return cardBySku.get(String(listing.sku));
  if (listing.listingId && cardByListingId.has(String(listing.listingId))) {
    return cardByListingId.get(String(listing.listingId));
  }
  const titleKey = normalizeTitleKey(listing.title);
  if (titleKey && cardByTitle.has(titleKey)) return cardByTitle.get(titleKey);
  return null;
}

export async function handleListingImportApiRoutes(req, res, { pathname }) {
  if (req.method === "POST" && pathname === "/api/listings/import-untracked") {
    if (importInProgress) {
      sendJson(res, 409, { error: "An import is already in progress — try again shortly." });
      return true;
    }
    importInProgress = true;
    try {
      const { cardBySku, cardByListingId, cardByTitle, trackedOffers } = await withStateReadOnly(
        async (state) => {
          const cards = Array.isArray(state.cardItems) ? state.cardItems : [];
          const cardBySku = new Map();
          const cardByListingId = new Map();
          const cardByTitle = new Map();
          for (const card of cards) {
            if (card?.sku) cardBySku.set(String(card.sku), card.id);
            if (card?.listingId) cardByListingId.set(String(card.listingId), card.id);
            const titleKey = normalizeTitleKey(card?.ebayTitle);
            if (titleKey && !cardByTitle.has(titleKey)) cardByTitle.set(titleKey, card.id);
          }
          return {
            cardBySku,
            cardByListingId,
            cardByTitle,
            trackedOffers: buildMinimalTrackedOffers(state),
          };
        },
      );

      // pageSize 100 x maxPages 10 = up to 1000 listings, comfortably above
      // this account's ~850 active listings (the same undercount bug fixed
      // elsewhere this session for a 100 x 5 = 500 cap).
      const activeListings = await fetchEbayActiveListings({
        offers: trackedOffers,
        pageSize: 100,
        maxPages: 10,
      });

      const untracked = activeListings.filter((listing) => {
        if (!(listing?.listingId || listing?.listingUrl)) return false;
        return !findExistingCardId({ cardBySku, cardByListingId, cardByTitle }, listing);
      });

      if (!untracked.length) {
        sendJson(res, 200, {
          imported: 0,
          skippedAlreadyTracked: activeListings.length,
          unidentified: [],
          totalActiveListings: activeListings.length,
        });
        return true;
      }

      const result = await withState(async (state) => {
        const batch = {
          id: createId(state, "batch"),
          source: "ebay_untracked_import",
          notes: `Imported ${untracked.length} existing eBay listing(s) that had no local record.`,
          // Already live on eBay — nothing left to process, so this batch
          // starts in the same terminal state the normal publish route
          // lands on, not "processing" (which feature 3's stuck-batch
          // detection would otherwise flag forever, since nothing ever
          // transitions an already-published batch out of "processing").
          status: "published",
          createdAt: nowIso(),
          updatedAt: nowIso(),
          publishChecklist: [],
        };
        state.batches.push(batch);

        const importedIds = [];
        const unidentified = [];
        for (const listing of untracked) {
          const cardItemId = createId(state, "card");
          const metadata = inferMetadataFromTitle(listing.title || "", {
            provider: "ebay_untracked_import",
            notesPrefix: "Untracked eBay listing",
          });

          const imageUrls = Array.isArray(listing.imageUrls) && listing.imageUrls.length
            ? listing.imageUrls
            : listing.imageUrl
              ? [listing.imageUrl]
              : [];
          let frontImage = null;
          let backImage = null;
          if (imageUrls[0]) {
            frontImage = {
              id: createId(state, "img"),
              cardItemId,
              gradingItemId: null,
              side: "front",
              fileName: null,
              mimeType: null,
              storagePath: null,
              url: imageUrls[0],
              byteLength: null,
              createdAt: nowIso(),
            };
            state.cardImages.push(frontImage);
          }
          if (imageUrls[1]) {
            backImage = {
              id: createId(state, "img"),
              cardItemId,
              gradingItemId: null,
              side: "back",
              fileName: null,
              mimeType: null,
              storagePath: null,
              url: imageUrls[1],
              byteLength: null,
              createdAt: nowIso(),
            };
            state.cardImages.push(backImage);
          }

          const price = normalizeMoney(listing.currentPrice);
          const publishedAt = listing.listedAt || nowIso();

          const cardItem = {
            id: cardItemId,
            batchId: batch.id,
            confidenceScore: metadata?.confidence ?? 0,
            recommendedPrice: price,
            currency: "USD",
            isThickCard: false,
            candidateBaseHint: false,
            candidateAutoHint: Boolean(metadata?.autographFlag),
            createdAt: nowIso(),
            updatedAt: nowIso(),
            publishState: "published",
            frontImageId: frontImage?.id || null,
            backImageId: backImage?.id || null,
            notes: "",
            // Never invent a SKU here — eBay's own inventory item is
            // already keyed by whatever (if anything) it returned.
            sku: listing.sku || null,
            status: "listed",
            ebayTitle: listing.title || null,
            listingId: listing.listingId || null,
            listingUrl: listing.listingUrl || null,
            publishedAt,
            candidatePlayer: metadata?.playerName || null,
            candidateYear: metadata?.year || null,
            candidateSetName: metadata?.setName || null,
            candidateCardNumber: metadata?.cardNumber || null,
            candidateParallel: metadata?.parallel || null,
            candidateSport: metadata?.sport || null,
            candidateRookieFlag: Boolean(metadata?.rookieFlag),
            // Seeded now, same as the two publish routes — this listing's
            // current live price is its true, permanent repricer anchor,
            // not whatever the scheduler happens to see on its first pass.
            repriceBaselinePrice: price,
          };
          state.cardItems.push(cardItem);

          const offer = {
            id: createId(state, "offer"),
            cardItemId,
            // Unknown for a pre-existing listing (GetMyeBaySelling doesn't
            // expose it) — fine, updateEbayListingPrice already prefers the
            // listingId-based Trading API path whenever listingId is set.
            ebayOfferId: null,
            sku: cardItem.sku,
            price,
            quantity: Number.isFinite(listing.quantity) && listing.quantity > 0 ? listing.quantity : 1,
            status: "published",
            listingId: listing.listingId || null,
            listingUrl: listing.listingUrl || null,
            publishedAt,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };
          state.offers.push(offer);

          createAuditEvent(state, "cardItem", cardItemId, "ebay_untracked_import", {
            listingId: listing.listingId,
            sku: cardItem.sku,
            price,
          });

          importedIds.push(cardItemId);
          if (!metadata) unidentified.push(cardItemId);
        }

        createAuditEvent(state, "batch", batch.id, "ebay_untracked_import", {
          cardCount: importedIds.length,
        });

        return { imported: importedIds.length, unidentified };
      });

      sendJson(res, 200, {
        imported: result.imported,
        skippedAlreadyTracked: activeListings.length - untracked.length,
        unidentified: result.unidentified,
        totalActiveListings: activeListings.length,
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    } finally {
      importInProgress = false;
    }
    return true;
  }

  return false;
}
