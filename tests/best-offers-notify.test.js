import test from "node:test";
import assert from "node:assert/strict";
import { selectNewPendingBestOffers } from "../src/app.js";

// The scheduled Best Offers scan must only push a notification for offers
// no prior scan has already pinged — a 30-minute rescan of a still-pending
// offer re-notifying every time would train the user to ignore the pings.

test("selects only offers that have not been notified about yet", () => {
  const entries = [
    { bestOfferId: "111", offerAmount: 3.25 },
    { bestOfferId: "222", offerAmount: 5 },
  ];
  const picked = selectNewPendingBestOffers(entries, new Set(["111"]));
  assert.deepEqual(picked.map((e) => e.bestOfferId), ["222"]);
});

test("skips per-listing error placeholders and entries without an offer id", () => {
  const entries = [
    { error: "comp lookup timed out", listingUrl: "https://ebay.com/itm/1" },
    { bestOfferId: null },
    { bestOfferId: "333" },
  ];
  const picked = selectNewPendingBestOffers(entries, new Set());
  assert.deepEqual(picked.map((e) => e.bestOfferId), ["333"]);
});

test("handles missing/empty inputs gracefully", () => {
  assert.deepEqual(selectNewPendingBestOffers(undefined, new Set()), []);
  assert.deepEqual(selectNewPendingBestOffers([], new Set()), []);
});
