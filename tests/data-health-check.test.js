import test from "node:test";
import assert from "node:assert/strict";
import { findDataHealthIssues } from "../src/jobs/data-health-check.js";

test("flags a candidatePlayer/reviewed-identity mismatch (the card_0063 pattern)", () => {
  const result = findDataHealthIssues({
    cardItems: [
      {
        id: "card_0063",
        candidatePlayer: "Corbin Carroll",
        ebaySpecifics: { "Player/Athlete": ["Jalen Green"] },
      },
    ],
  });
  assert.equal(result.issuesFound, 1);
  assert.equal(result.issues[0].type, "identity_mismatch");
  assert.equal(result.issues[0].cardId, "card_0063");
});

test("does not flag matching names, substrings, or shared tokens", () => {
  const result = findDataHealthIssues({
    cardItems: [
      { id: "c1", candidatePlayer: "Jalen Green", ebaySpecifics: { "Player/Athlete": ["Jalen Green"] } },
      { id: "c2", candidatePlayer: "Jalen Green Jr.", ebaySpecifics: { "Player/Athlete": ["Jalen Green"] } },
      { id: "c3", candidatePlayer: "Victor Wembanyama", ebaySpecifics: { "Player/Athlete": ["Wembanyama"] } },
    ],
  });
  assert.equal(result.issuesFound, 0);
});

test("skips the identity check when either side is missing", () => {
  const result = findDataHealthIssues({
    cardItems: [
      { id: "c1", candidatePlayer: "Corbin Carroll", ebaySpecifics: {} },
      { id: "c2", candidatePlayer: null, ebaySpecifics: { "Player/Athlete": ["Jalen Green"] } },
    ],
  });
  assert.equal(result.issuesFound, 0);
});

test("flags an image reference that doesn't exist in cardImages", () => {
  const result = findDataHealthIssues({
    cardItems: [{ id: "c1", frontImageId: "img_missing", backImageId: "img_0001" }],
    cardImages: [{ id: "img_0001" }],
  });
  assert.equal(result.issuesFound, 1);
  assert.equal(result.issues[0].type, "orphaned_image_ref");
  assert.match(result.issues[0].message, /img_missing/);
});

test("flags a published card with no listingId or listingUrl", () => {
  const result = findDataHealthIssues({
    cardItems: [{ id: "c1", status: "listed", publishState: "published" }],
  });
  assert.equal(result.issuesFound, 1);
  assert.equal(result.issues[0].type, "published_without_listing");
});

test("does not flag a published card that has a listingUrl", () => {
  const result = findDataHealthIssues({
    cardItems: [{ id: "c1", status: "listed", listingUrl: "https://www.ebay.com/itm/123" }],
  });
  assert.equal(result.issuesFound, 0);
});

test("flags an offer referencing a card that doesn't exist", () => {
  const result = findDataHealthIssues({
    cardItems: [{ id: "card_0001" }],
    offers: [{ id: "offer_1", cardItemId: "card_9999" }],
  });
  assert.equal(result.issuesFound, 1);
  assert.equal(result.issues[0].type, "orphaned_offer");
});

test("flags duplicate SKUs shared across cards", () => {
  const result = findDataHealthIssues({
    cardItems: [
      { id: "card_0001", sku: "batch_0001-card_0001" },
      { id: "card_0002", sku: "batch_0001-card_0001" },
    ],
  });
  assert.equal(result.issuesFound, 1);
  assert.equal(result.issues[0].type, "duplicate_sku");
  assert.deepEqual(result.issues[0].cardIds, ["card_0001", "card_0002"]);
});

test("returns no issues for clean, well-formed state", () => {
  const result = findDataHealthIssues({
    cardItems: [
      {
        id: "card_0001",
        sku: "batch_0001-card_0001",
        frontImageId: "img_0001",
        backImageId: "img_0002",
        status: "priced",
      },
    ],
    cardImages: [{ id: "img_0001" }, { id: "img_0002" }],
    offers: [{ id: "offer_1", cardItemId: "card_0001" }],
  });
  assert.equal(result.issuesFound, 0);
  assert.equal(result.checkedCards, 1);
  assert.equal(result.checkedOffers, 1);
});
