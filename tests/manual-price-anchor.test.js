import test from "node:test";
import assert from "node:assert/strict";
import {
  applyManualPriceAnchor,
  manualAnchorMaxMultiple,
  soldCompAnchorBypassMin,
} from "../src/services/active-listing-pricing.js";

// The filename price is a HUMAN read of the card. It became the anchor while
// eBay's completed listings were unreachable and the computed figure could
// only be derived from other sellers' ASKS. Rule for that case: never price
// below the human's read, but let a genuinely hot market pull the price up,
// capped so one absurd asking price can't run away with it.
//
// As of 2026-07-30 the Apify sold actor works again, so that premise no longer
// always holds. Once there are enough REAL completed sales, they lead and the
// filename read is recorded as evidence rather than clamping the price — see
// the sold-comp bypass tests at the bottom.

test("the manual price is a floor — a soft market cannot drag the price down", () => {
  const r = applyManualPriceAnchor(3, 10);
  assert.equal(r.price, 10);
  assert.equal(r.basis, "manual_floor");
  assert.match(r.reason, /holding the manual price/);
});

test("a hot market above the manual price is followed", () => {
  const r = applyManualPriceAnchor(15, 10);
  assert.equal(r.price, 15);
  assert.equal(r.basis, "market_hot");
});

test("a runaway market is capped at the configured multiple of the manual price", () => {
  const r = applyManualPriceAnchor(500, 10, { maxMultiple: 2 });
  assert.equal(r.price, 20);
  assert.equal(r.basis, "manual_capped");
  assert.match(r.reason, /capping/);
});

test("with no manual price the market figure passes through unchanged", () => {
  const r = applyManualPriceAnchor(12.34, null);
  assert.equal(r.price, 12.34);
  assert.equal(r.basis, "market");
});

test("with no market data the manual price is used outright", () => {
  const r = applyManualPriceAnchor(null, 7);
  assert.equal(r.price, 7);
  assert.equal(r.basis, "manual");
});

test("neither price available yields null rather than a guess", () => {
  const r = applyManualPriceAnchor(null, null);
  assert.equal(r.price, null);
  assert.equal(r.basis, "none");
});

test("equal prices hold at the manual figure", () => {
  const r = applyManualPriceAnchor(10, 10);
  assert.equal(r.price, 10);
  assert.equal(r.basis, "manual_floor");
});

test("zero/negative inputs are treated as absent, not as real prices", () => {
  assert.equal(applyManualPriceAnchor(10, 0).basis, "market");
  assert.equal(applyManualPriceAnchor(0, 10).basis, "manual");
  assert.equal(applyManualPriceAnchor(-5, -5).basis, "none");
});

test("the cap multiple is configurable and defaults to 2x", () => {
  const original = process.env.MANUAL_ANCHOR_MAX_MULTIPLE;
  delete process.env.MANUAL_ANCHOR_MAX_MULTIPLE;
  assert.equal(manualAnchorMaxMultiple(), 2);
  process.env.MANUAL_ANCHOR_MAX_MULTIPLE = "3";
  assert.equal(manualAnchorMaxMultiple(), 3);
  assert.equal(applyManualPriceAnchor(500, 10).price, 30);
  // A multiple below 1 would make the manual price a ceiling below itself —
  // nonsensical, so it falls back to the default.
  process.env.MANUAL_ANCHOR_MAX_MULTIPLE = "0.5";
  assert.equal(manualAnchorMaxMultiple(), 2);
  if (original === undefined) delete process.env.MANUAL_ANCHOR_MAX_MULTIPLE;
  else process.env.MANUAL_ANCHOR_MAX_MULTIPLE = original;
});

test("setting the multiple to exactly 1 pins the price to the manual value", () => {
  assert.equal(applyManualPriceAnchor(999, 10, { maxMultiple: 1 }).price, 10);
});


// ── Sold-comp bypass (re-integration, 2026-07-30) ──
// The anchor was a stand-in for unreachable sold data. With the actor working
// again, clamping a sold-comp median to a multiple of a number typed into a
// filename would throw away the better evidence.

test("the anchor still clamps while sold-comp evidence is thin", () => {
  const r = applyManualPriceAnchor(50, 7, { soldCompCount: 2 });
  assert.equal(r.basis, "manual_capped");
  assert.equal(r.price, 14);
});

test("the anchor steps aside once there are enough sold comps", () => {
  const r = applyManualPriceAnchor(50, 7, { soldCompCount: 3 });
  assert.equal(r.basis, "sold_comps");
  assert.equal(r.price, 50);
  assert.equal(r.manualPrice, 7, "the human read is still recorded as evidence");
  assert.equal(r.soldCompCount, 3);
});

test("omitting the sold-comp count preserves the previous behaviour exactly", () => {
  const r = applyManualPriceAnchor(50, 7);
  assert.equal(r.basis, "manual_capped");
  assert.equal(r.price, 14);
});

test("the sold-comp floor case is unaffected by the bypass", () => {
  // Market below the manual read with strong sold evidence: sold comps lead,
  // so the price is allowed to sit below the human's number.
  const r = applyManualPriceAnchor(3, 10, { soldCompCount: 5 });
  assert.equal(r.basis, "sold_comps");
  assert.equal(r.price, 3);
});

test("MANUAL_ANCHOR_SOLD_COMP_MIN tunes the bypass threshold", () => {
  const previous = process.env.MANUAL_ANCHOR_SOLD_COMP_MIN;
  process.env.MANUAL_ANCHOR_SOLD_COMP_MIN = "10";
  try {
    assert.equal(soldCompAnchorBypassMin(), 10);
    assert.equal(applyManualPriceAnchor(50, 7, { soldCompCount: 5 }).basis, "manual_capped");
    assert.equal(applyManualPriceAnchor(50, 7, { soldCompCount: 10 }).basis, "sold_comps");
  } finally {
    if (previous === undefined) delete process.env.MANUAL_ANCHOR_SOLD_COMP_MIN;
    else process.env.MANUAL_ANCHOR_SOLD_COMP_MIN = previous;
  }
});
