import test from "node:test";
import assert from "node:assert/strict";
import { planBulkAgeReprice } from "../src/app.js";

const NOW = Date.parse("2026-07-10T00:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

function row(overrides = {}) {
  return {
    listingId: "1001",
    sku: "sku-1",
    title: "Test Card",
    format: "FIXED_PRICE",
    currentPrice: 10,
    listedAt: daysAgo(120),
    ...overrides,
  };
}

test("targets only listings older than the cutoff", () => {
  const plan = planBulkAgeReprice(
    [row({ listingId: "old", listedAt: daysAgo(120) }), row({ listingId: "new", listedAt: daysAgo(30) })],
    { olderThanDays: 90, percentage: -10, now: NOW },
  );
  assert.deepEqual(plan.targets.map((t) => t.listingId), ["old"]);
  assert.equal(plan.skipped.tooNew, 1);
});

test("computes the percentage change with cent rounding, both directions", () => {
  const down = planBulkAgeReprice([row({ currentPrice: 8.15 })], { olderThanDays: 90, percentage: -10, now: NOW });
  assert.equal(down.targets[0].oldPrice, 8.15);
  assert.equal(down.targets[0].newPrice, 7.34); // 8.15 * 0.9 = 7.335 -> 7.34
  const up = planBulkAgeReprice([row({ currentPrice: 10 })], { olderThanDays: 90, percentage: 5, now: NOW });
  assert.equal(up.targets[0].newPrice, 10.5);
});

test("skips auctions, unknown ages, invalid prices, sub-$0.99 results, and no-op changes", () => {
  const plan = planBulkAgeReprice(
    [
      row({ listingId: "a", format: "AUCTION" }),
      row({ listingId: "b", listedAt: null }),
      row({ listingId: "c", currentPrice: 0 }),
      row({ listingId: "d", currentPrice: 1.0 }), // 1.00 * 0.9 = 0.90 -> below eBay's floor
      row({ listingId: "e", currentPrice: 10, minBound: 10 }), // clamped back to 10 -> unchanged
      row({ listingId: "f", currentPrice: 10 }),
    ],
    { olderThanDays: 90, percentage: -10, now: NOW },
  );
  assert.deepEqual(plan.targets.map((t) => t.listingId), ["f"]);
  assert.equal(plan.skipped.auction, 1);
  assert.equal(plan.skipped.unknownAge, 1);
  assert.equal(plan.skipped.invalidPrice, 1);
  assert.equal(plan.skipped.belowMinimum, 1);
  assert.equal(plan.skipped.unchanged, 1);
});

test("honors per-card absolute min/max bounds, same rails as the scheduled repricer", () => {
  const floored = planBulkAgeReprice([row({ currentPrice: 10, minBound: 9.5 })], { olderThanDays: 90, percentage: -10, now: NOW });
  assert.equal(floored.targets[0].newPrice, 9.5); // 9.00 clamped up to the card's own floor
  const capped = planBulkAgeReprice([row({ currentPrice: 10, maxBound: 10.25 })], { olderThanDays: 90, percentage: 10, now: NOW });
  assert.equal(capped.targets[0].newPrice, 10.25); // 11.00 clamped down to the card's own cap
});

test("reports days listed on each target", () => {
  const plan = planBulkAgeReprice([row({ listedAt: daysAgo(365) })], { olderThanDays: 90, percentage: -10, now: NOW });
  assert.equal(plan.targets[0].daysListed, 365);
});

test("rejects invalid inputs outright", () => {
  assert.throws(() => planBulkAgeReprice([], { olderThanDays: 0, percentage: -10 }), /positive number of days/);
  assert.throws(() => planBulkAgeReprice([], { olderThanDays: 90, percentage: 0 }), /non-zero/);
  assert.throws(() => planBulkAgeReprice([], { olderThanDays: 90, percentage: -60 }), /between -50 and 50/);
  assert.throws(() => planBulkAgeReprice([], { olderThanDays: 90, percentage: "abc" }), /non-zero/);
});
