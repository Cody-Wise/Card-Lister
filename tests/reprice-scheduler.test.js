import test from "node:test";
import assert from "node:assert/strict";
import { clampRepriceTarget } from "../src/jobs/reprice-scheduler.js";

test("clampRepriceTarget caps a target more than 20% above the current price", () => {
  const result = clampRepriceTarget(50, 20);
  assert.equal(result.price, 24);
  assert.equal(result.clamped, true);
});

test("clampRepriceTarget floors a target more than 20% below the current price", () => {
  const result = clampRepriceTarget(2, 20);
  assert.equal(result.price, 16);
  assert.equal(result.clamped, true);
});

test("clampRepriceTarget leaves a target within the +/-20% band untouched", () => {
  const result = clampRepriceTarget(22, 20);
  assert.equal(result.price, 22);
  assert.equal(result.clamped, false);
});

test("clampRepriceTarget treats the exact 80%/120% boundary as untouched, not clamped", () => {
  assert.deepEqual(clampRepriceTarget(16, 20), { price: 16, clamped: false, min: 16, max: 24 });
  assert.deepEqual(clampRepriceTarget(24, 20), { price: 24, clamped: false, min: 16, max: 24 });
});

test("clampRepriceTarget honors REPRICE_MIN_FACTOR/REPRICE_MAX_FACTOR env overrides", () => {
  const originalMin = process.env.REPRICE_MIN_FACTOR;
  const originalMax = process.env.REPRICE_MAX_FACTOR;
  process.env.REPRICE_MIN_FACTOR = "0.5";
  process.env.REPRICE_MAX_FACTOR = "1.5";
  try {
    const result = clampRepriceTarget(5, 20);
    assert.equal(result.price, 10);
    assert.equal(result.min, 10);
    assert.equal(result.max, 30);
  } finally {
    if (originalMin === undefined) delete process.env.REPRICE_MIN_FACTOR;
    else process.env.REPRICE_MIN_FACTOR = originalMin;
    if (originalMax === undefined) delete process.env.REPRICE_MAX_FACTOR;
    else process.env.REPRICE_MAX_FACTOR = originalMax;
  }
});

test("clampRepriceTarget ignores an out-of-range env override and falls back to the 0.8/1.2 default", () => {
  const original = process.env.REPRICE_MIN_FACTOR;
  process.env.REPRICE_MIN_FACTOR = "1.5"; // invalid: must be < 1
  try {
    const result = clampRepriceTarget(10, 20);
    assert.equal(result.min, 16);
  } finally {
    if (original === undefined) delete process.env.REPRICE_MIN_FACTOR;
    else process.env.REPRICE_MIN_FACTOR = original;
  }
});
