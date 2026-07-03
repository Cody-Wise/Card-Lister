// Periodic data-quality scan. Read-only — flags issues for a human to look
// at (via console output; the scheduler in server.js logs the summary) but
// never mutates state itself. Modeled after the card_0063 SKU-mismatch bug:
// a heuristic OCR guess got saved into candidatePlayer/candidateSport/etc,
// while the actual reviewed identity (ebayTitle/ebaySpecifics) disagreed, and
// nothing surfaced the drift until a live repricing lookup searched for the
// wrong player. These checks are structural/cheap — no network calls — so
// this can run frequently without cost.
import { withStateReadOnly } from "../lib/store.js";

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function namesLikelyDisagree(a, b) {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return false;
  if (left === right || left.includes(right) || right.includes(left)) return false;
  // Cheap token-overlap check: if any word (3+ chars) is shared, treat as the
  // same person rather than risk a false positive on suffixes/nicknames.
  const leftTokens = left.split(" ").filter((t) => t.length >= 3);
  const rightTokens = right.split(" ").filter((t) => t.length >= 3);
  return !leftTokens.some((t) => rightTokens.includes(t));
}

// The card_0063 pattern: candidatePlayer (from OCR/seed-catalog matching)
// disagrees with the actual reviewed identity in ebaySpecifics.
function checkIdentityMismatch(card) {
  const candidatePlayer = card.candidatePlayer;
  const reviewedPlayer = card.ebaySpecifics?.["Player/Athlete"]?.[0];
  if (!candidatePlayer || !reviewedPlayer) return null;
  if (!namesLikelyDisagree(candidatePlayer, reviewedPlayer)) return null;
  return {
    type: "identity_mismatch",
    cardId: card.id,
    message: `candidatePlayer "${candidatePlayer}" disagrees with reviewed Player/Athlete "${reviewedPlayer}" — repricing/comp lookups that fall back to candidate* fields will search for the wrong card.`,
  };
}

function checkOrphanedImageRefs(card, imageIds) {
  const issues = [];
  for (const field of ["frontImageId", "backImageId"]) {
    const id = card[field];
    if (id && !imageIds.has(id)) {
      issues.push({
        type: "orphaned_image_ref",
        cardId: card.id,
        message: `${field} "${id}" does not exist in cardImages.`,
      });
    }
  }
  return issues;
}

function checkPublishedWithoutListing(card) {
  const isPublished = card.status === "listed" || card.publishState === "published";
  if (!isPublished) return null;
  if (card.listingId || card.listingUrl) return null;
  return {
    type: "published_without_listing",
    cardId: card.id,
    message: `Card is marked ${card.status}/${card.publishState} but has no listingId or listingUrl.`,
  };
}

function checkOrphanedOffers(offers, cardIds) {
  const issues = [];
  for (const offer of offers) {
    if (offer.cardItemId && !cardIds.has(offer.cardItemId)) {
      issues.push({
        type: "orphaned_offer",
        offerId: offer.id,
        message: `Offer references cardItemId "${offer.cardItemId}", which does not exist.`,
      });
    }
  }
  return issues;
}

function checkDuplicateSkus(cardItems) {
  const bySku = new Map();
  for (const card of cardItems) {
    if (!card.sku) continue;
    const bucket = bySku.get(card.sku) || [];
    bucket.push(card.id);
    bySku.set(card.sku, bucket);
  }
  const issues = [];
  for (const [sku, ids] of bySku) {
    if (ids.length > 1) {
      issues.push({
        type: "duplicate_sku",
        cardIds: ids,
        message: `SKU "${sku}" is shared by ${ids.length} cards: ${ids.join(", ")}.`,
      });
    }
  }
  return issues;
}

// Pure: runs every check against a plain state-shaped object. Exported
// separately from runDataHealthCheck() so tests can exercise the detection
// rules directly with synthetic data, without needing a real state.json.
export function findDataHealthIssues({ cardItems = [], cardImages = [], offers = [] } = {}) {
  const imageIds = new Set(cardImages.map((img) => img.id));
  const cardIds = new Set(cardItems.map((card) => card.id));

  const issues = [];
  for (const card of cardItems) {
    const mismatch = checkIdentityMismatch(card);
    if (mismatch) issues.push(mismatch);
    issues.push(...checkOrphanedImageRefs(card, imageIds));
    const publishIssue = checkPublishedWithoutListing(card);
    if (publishIssue) issues.push(publishIssue);
  }
  issues.push(...checkOrphanedOffers(offers, cardIds));
  issues.push(...checkDuplicateSkus(cardItems));

  return {
    checkedCards: cardItems.length,
    checkedOffers: offers.length,
    issuesFound: issues.length,
    issues,
  };
}

export async function runDataHealthCheck() {
  const { cardItems, cardImages, offers } = await withStateReadOnly((state) => ({
    cardItems: [...(state.cardItems || [])],
    cardImages: [...(state.cardImages || [])],
    offers: [...(state.offers || [])],
  }));

  return findDataHealthIssues({ cardItems, cardImages, offers });
}
