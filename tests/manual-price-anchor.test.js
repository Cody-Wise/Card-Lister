import test from "node:test";
import assert from "node:assert/strict";
import { applyManualPriceAnchor, manualAnchorMaxMultiple } from "../src/services/active-listing-pricing.js";

// The filename price is a HUMAN read of the card and is the most trustworthy
// number available: sold comps are gone (eBay sign-in wall), so the computed
// figure is derived from other sellers' ASKS. The rule: never price below
// the human's read, but let a genuinely hot market pull the price up, capped
// so one absurd asking price can't run away with it.

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
