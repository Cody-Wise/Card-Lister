import test from "node:test";
import assert from "node:assert/strict";
import { extractItemIdFromListingUrl, respondToBestOffer } from "../src/services/ebay-best-offers.js";

test("extractItemIdFromListingUrl pulls the legacy numeric ItemID out of a real eBay listing URL", () => {
  assert.equal(
    extractItemIdFromListingUrl("https://www.ebay.com/itm/236917541201"),
    "236917541201",
  );
});

test("extractItemIdFromListingUrl returns null for a URL with no /itm/ segment", () => {
  assert.equal(extractItemIdFromListingUrl("https://www.ebay.com/sch/i.html?_nkw=kyler+murray"), null);
});

test("extractItemIdFromListingUrl returns null for a missing/empty URL", () => {
  assert.equal(extractItemIdFromListingUrl(null), null);
  assert.equal(extractItemIdFromListingUrl(""), null);
});

test("extractItemIdFromListingUrl pulls the trailing numeric ID out of an SEO-slugged URL, not the leading year", () => {
  // Real live bug: RespondToBestOffer (Accept) failed with 'Item "2024" is
  // invalid' — the old /\/itm\/(\d+)/ pattern matched the first run of
  // digits after "/itm/", which for a slug starting with a year is the
  // year itself, not the real item ID at the end of the path.
  assert.equal(
    extractItemIdFromListingUrl(
      "https://www.ebay.com/itm/2024-25-Panini-Select-Neon-Icons-Victor-Wembanyama-23/236298326630",
    ),
    "236298326630",
  );
});

test("extractItemIdFromListingUrl strips a query string before extracting from either URL shape", () => {
  assert.equal(
    extractItemIdFromListingUrl("https://www.ebay.com/itm/236917541201?nordt=true"),
    "236917541201",
  );
  assert.equal(
    extractItemIdFromListingUrl(
      "https://www.ebay.com/itm/2024-Some-Slug/236298326630?hash=item36e71bc820:g:abc",
    ),
    "236298326630",
  );
});

// respondToBestOffer validates its inputs synchronously before ever making a
// network call, so these reject before touching the Trading API — real
// requests against a live offer are exercised manually via the UI (this is
// a real, consequential action against a real buyer; not something to fire
// automatically in a test suite).

test("respondToBestOffer rejects a non-numeric itemId/bestOfferId rather than embedding it in outbound XML", async () => {
  await assert.rejects(
    () => respondToBestOffer({ itemId: "not-a-number", bestOfferId: "12345", action: "Accept" }),
    /numeric itemId and bestOfferId/,
  );
  await assert.rejects(
    () => respondToBestOffer({ itemId: "236917541201", bestOfferId: "<script>", action: "Accept" }),
    /numeric itemId and bestOfferId/,
  );
});

test("respondToBestOffer rejects an invalid action", async () => {
  await assert.rejects(
    () => respondToBestOffer({ itemId: "236917541201", bestOfferId: "12345", action: "Approve" }),
    /invalid action/,
  );
});

test("respondToBestOffer requires a positive counterOfferPrice for a Counter action", async () => {
  await assert.rejects(
    () => respondToBestOffer({ itemId: "236917541201", bestOfferId: "12345", action: "Counter" }),
    /counterOfferPrice is required/,
  );
  await assert.rejects(
    () =>
      respondToBestOffer({
        itemId: "236917541201",
        bestOfferId: "12345",
        action: "Counter",
        counterOfferPrice: -5,
      }),
    /counterOfferPrice is required/,
  );
});
