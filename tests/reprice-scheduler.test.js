import test from "node:test";
import assert from "node:assert/strict";
import {
  clampRepriceTarget,
  matchesTargetGrade,
  filterExactMatchComps,
  applyAbsoluteBounds,
} from "../src/jobs/reprice-scheduler.js";

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

// --- matchesTargetGrade / filterExactMatchComps -----------------------------
// Reproduces the real card_0109 bug: a raw-vs-graded (or wrong-grade) comp
// getting trusted as if it were comparable, because nothing checked grade at
// all before this fix.

test("matchesTargetGrade rejects a raw comp against a graded target", () => {
  const gradeTarget = { isGraded: true, grader: "PSA", grade: "10" };
  const comp = { title: "2019 Donruss Kyler Murray #100 RC" };
  assert.equal(matchesTargetGrade(comp, gradeTarget), false);
});

test("matchesTargetGrade rejects a graded comp against a raw target", () => {
  const gradeTarget = { isGraded: false, grader: null, grade: null };
  const comp = { title: "2019 Donruss Kyler Murray #100 RC PSA 10" };
  assert.equal(matchesTargetGrade(comp, gradeTarget), false);
});

test("matchesTargetGrade rejects a different grader/grade than the target", () => {
  const gradeTarget = { isGraded: true, grader: "PSA", grade: "10" };
  assert.equal(
    matchesTargetGrade({ title: "2019 Donruss Kyler Murray #100 RC BGS 9.5" }, gradeTarget),
    false,
    "different grader",
  );
  assert.equal(
    matchesTargetGrade({ title: "2019 Donruss Kyler Murray #100 RC PSA 9" }, gradeTarget),
    false,
    "same grader, different grade",
  );
});

test("matchesTargetGrade accepts a comp with the same grader and grade", () => {
  const gradeTarget = { isGraded: true, grader: "PSA", grade: "10" };
  assert.equal(matchesTargetGrade({ title: "2019 Donruss Kyler Murray #100 RC PSA 10" }, gradeTarget), true);
});

test("matchesTargetGrade accepts two raw comps with no grade info at all", () => {
  const gradeTarget = { isGraded: false, grader: null, grade: null };
  assert.equal(matchesTargetGrade({ title: "2019 Donruss Kyler Murray #100 RC" }, gradeTarget), true);
});

test("filterExactMatchComps drops a wrong-player comp even if the grade matches", () => {
  const lookupMetadata = { playerName: "Kyler Murray", year: 2019, cardNumber: "100", setName: "Donruss" };
  const gradeTarget = { isGraded: true, grader: "PSA", grade: "10" };
  const comps = [
    { title: "2019 Donruss Josh Allen #100 RC PSA 10" }, // wrong player
    { title: "2019 Donruss Kyler Murray #100 RC PSA 10" }, // exact match
  ];
  const filtered = filterExactMatchComps(comps, lookupMetadata, gradeTarget);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].title, "2019 Donruss Kyler Murray #100 RC PSA 10");
});

test("filterExactMatchComps drops a grade-mismatched comp even though it's otherwise an identity match", () => {
  // This is exactly the card_0109 shape: same player/year/set, but the comp
  // that broke pricing was a totally different parallel/grade.
  const lookupMetadata = { playerName: "Kyler Murray", year: 2019, cardNumber: "100", setName: "Donruss" };
  const gradeTarget = { isGraded: true, grader: "PSA", grade: "10" };
  const comps = [
    { title: "2019 Donruss Kyler Murray #100 RC" }, // raw — no grade at all
    { title: "2019 Donruss Kyler Murray #100 RC PSA 9" }, // wrong grade
  ];
  assert.deepEqual(filterExactMatchComps(comps, lookupMetadata, gradeTarget), []);
});

// --- applyAbsoluteBounds ----------------------------------------------------

test("applyAbsoluteBounds caps a price above the absolute max", () => {
  assert.equal(applyAbsoluteBounds(500, null, 200), 200);
});

test("applyAbsoluteBounds floors a price below the absolute min", () => {
  assert.equal(applyAbsoluteBounds(5, 20, null), 20);
});

test("applyAbsoluteBounds passes a price through untouched when no bounds are set", () => {
  assert.equal(applyAbsoluteBounds(42.5, null, null), 42.5);
});

test("applyAbsoluteBounds ignores non-positive/invalid bound values", () => {
  assert.equal(applyAbsoluteBounds(42.5, 0, -10), 42.5);
  assert.equal(applyAbsoluteBounds(42.5, NaN, undefined), 42.5);
});
