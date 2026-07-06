import test from "node:test";
import assert from "node:assert/strict";
import { calculatePrice } from "../src/services/pricing.js";
import { choosePricingStrategy, mergeDetectedMetadata } from "../src/jobs/pipeline.js";

test("prices from sold comps with trimming", () => {
  const result = calculatePrice({
    soldComps: [{ totalPrice: 10 }, { totalPrice: 11 }, { totalPrice: 12 }, { totalPrice: 40 }],
    activeListings: [{ price: 15 }],
  });
  assert.ok(result.recommendedPrice > 0);
  assert.equal(result.soldCompCount, 4);
  assert.equal(result.usedSoldCompCount, 3);
  assert.equal(result.evidence.sold.length, 3);
});

test("blends up when active listings are hot", () => {
  const result = calculatePrice({
    soldComps: [{ totalPrice: 10 }, { totalPrice: 11 }, { totalPrice: 12 }],
    activeListings: [{ price: 20 }, { price: 22 }, { price: 24 }],
  });

  assert.ok(result.recommendedPrice > 11);
  assert.ok(result.recommendedPrice < 24);
  assert.ok(
    result.reason.includes("active listings are hot") ||
      result.reason.includes("light active-listing check"),
  );
});

test("stays anchored when active listings are only mildly above sold comps", () => {
  const result = calculatePrice({
    soldComps: [{ totalPrice: 2.99 }, { totalPrice: 3.05 }, { totalPrice: 3.12 }],
    activeListings: [{ price: 4.0 }, { price: 4.1 }, { price: 4.2 }, { price: 4.3 }],
  });

  assert.ok(result.recommendedPrice >= 2.9);
  assert.ok(result.recommendedPrice <= 3.2);
  assert.ok(!result.reason.includes("active listings are hot"));
});

test("keeps numbered cards conservative unless the variant is also known", () => {
  assert.equal(choosePricingStrategy({ printRun: 75 }), "sold_comps_p25");
  assert.equal(choosePricingStrategy({ serialNumber: "002/150" }), "sold_comps_p25");
  assert.equal(
    choosePricingStrategy({ serialNumber: "002/150", parallel: "Blue Refractor" }),
    "sold_comps_median",
  );
  assert.equal(choosePricingStrategy({}), "sold_comps_p25");
});

test("prefers exact and similar parallel sold comps over base comps", () => {
  const result = calculatePrice({
    metadata: {
      parallel: "Blue Refractor",
    },
    soldComps: [
      { title: "2020 Panini Prizm Player Baseball 123 Base", totalPrice: 7 },
      { title: "2020 Panini Prizm Player Baseball 123 Blue Refractor", totalPrice: 18 },
      { title: "2020 Panini Prizm Player Baseball 123 Blue Refractor", totalPrice: 24 },
      { title: "2020 Panini Prizm Player Baseball 123 Gold", totalPrice: 10 },
    ],
    activeListings: [],
  });

  assert.equal(result.soldCompCount, 4);
  assert.equal(result.evidence.sold.length, 2);
  assert.equal(result.evidence.soldParallelFilterMode, "exact_parallel");
  assert.equal(result.recommendedPrice, 18);
});

test("uses serialized fallback when exact run is unavailable", () => {
  const result = calculatePrice({
    metadata: {
      parallel: "Disco Prizm",
      serialNumber: "58/75",
      printRun: 75,
    },
    soldComps: [
      { title: "Allen Iverson #291 Red Prizm /299", totalPrice: 34 },
      { title: "Allen Iverson #291 Red Power /50", totalPrice: 28 },
      { title: "Allen Iverson Base #291", totalPrice: 3 },
    ],
    activeListings: [],
    strategy: "sold_comps_median",
  });

  assert.equal(result.evidence.soldSerialFilterMode, "fallback_serialized");
  assert.equal(result.soldCompCount, 3);
  assert.equal(result.usedSoldCompCount, 2);
  assert.equal(result.evidence.sold.length, 2);
  assert.ok(result.evidence.sold.every((comp) => typeof comp.serialRunAdjustedPrice === "number"));
  assert.ok(result.recommendedPrice > 34);
});

test("uses exact serial run when available", () => {
  const result = calculatePrice({
    metadata: {
      parallel: "Disco Prizm",
      serialNumber: "58/75",
      printRun: 75,
    },
    soldComps: [
      { title: "Allen Iverson #291 Disco Prizm 75/75", totalPrice: 64 },
      { title: "Allen Iverson #291 Disco Prizm /75", totalPrice: 60 },
      { title: "Allen Iverson #291 Disco #Red /299", totalPrice: 34 },
    ],
    activeListings: [],
    strategy: "sold_comps_median",
  });

  assert.equal(result.evidence.soldSerialFilterMode, "exact_serial_run");
  assert.equal(result.usedSoldCompCount, 2);
  assert.equal(result.soldCompCount, 3);
  assert.equal(result.evidence.sold.length, 2);
  assert.equal(result.evidence.sold.every((comp) => !comp.serialRunAdjustedPrice), true);
});

test("uses the stronger sold/total signal when both are provided", () => {
  const result = calculatePrice({
    soldComps: [
      {
        salePrice: 10,
        totalPrice: 22,
        title: "Allen Iverson #291 Red Prizm /299",
      },
      {
        salePrice: 15,
        totalPrice: 34,
        title: "Allen Iverson #291 Red Power /75",
      },
    ],
    activeListings: [],
    metadata: { serialNumber: "58/75", printRun: 75, parallel: "Disco Prizm" },
    strategy: "sold_comps_median",
  });

  assert.equal(result.evidence.soldSerialFilterMode, "exact_serial_run");
  assert.equal(result.soldCompCount, 2);
  assert.equal(result.evidence.sold.length, 1);
  assert.equal(result.evidence.sold[0].serialRunAdjustedPrice, undefined);
  assert.equal(result.recommendedPrice, 34);
});

test("trusts a single exact-parallel sold comp over an unfiltered active-listing fallback", () => {
  // Mirrors a real production case: only one sold comp exists for this
  // specific parallel (~$11), and no active listing matched the parallel
  // either, so the active pool falls back to every other Wembanyama
  // parallel/set — including much pricier ones. Before the fix, having
  // fewer than 3 sold comps discarded that single exact match entirely and
  // used the noisy active median ($32+) instead.
  const result = calculatePrice({
    metadata: { parallel: "Green Ray Wave" },
    soldComps: [
      { title: "2024-25 Panini Donruss Optic #45 Green Ray Wave Prizm Victor Wembanyama - SP", totalPrice: 10.84 },
    ],
    activeListings: [
      { title: "2024-25 Panini Donruss Optic Victor Wembanyama #45 Green Seismic Prizm", totalPrice: 25 },
      { title: "2024-25 Donruss Optic Victor Wembanyama #45 Green Hyper /249 San Antonio Spurs", totalPrice: 50 },
      { title: "Panini 2024-25 Donruss Optic Victor Wembanyama Spurs Holo Prizm #45", totalPrice: 200 },
      { title: "Victor Wembanyama 2024-25 Panini Donruss Optic SILVER SP Spurs", totalPrice: 20 },
    ],
  });

  assert.equal(result.evidence.soldParallelFilterMode, "exact_parallel");
  assert.equal(result.evidence.activeParallelFilterMode, "parallel_not_found_all");
  assert.equal(result.recommendedPrice, 10.84);
  assert.ok(result.recommendedPrice < 30);
  assert.equal(result.confidence, "low");
  assert.ok(result.reason.includes("exact-parallel sold comp"));
});

test("lightly blends a single exact-parallel sold comp with active listings that also matched the parallel", () => {
  const result = calculatePrice({
    metadata: { parallel: "Green Ray Wave" },
    soldComps: [{ title: "Victor Wembanyama Green Ray Wave Prizm", totalPrice: 10 }],
    activeListings: [
      { title: "Victor Wembanyama Green Ray Wave Prizm", totalPrice: 20 },
      { title: "Victor Wembanyama Green Ray Wave Prizm", totalPrice: 22 },
    ],
  });

  assert.equal(result.evidence.soldParallelFilterMode, "exact_parallel");
  assert.equal(result.evidence.activeParallelFilterMode, "exact_parallel");
  assert.ok(result.recommendedPrice > 10);
  assert.ok(result.recommendedPrice < 15);
  assert.ok(result.reason.includes("Thin sold comps"));
});

test("uses sparse serial sold comps before active floor", () => {
  const result = calculatePrice({
    metadata: {
      parallel: "Disco Prizm",
      serialNumber: "58/75",
      printRun: 75,
    },
    soldComps: [{ title: "Allen Iverson #291 Disco Prizm /299", totalPrice: 31.97 }],
    activeListings: [
      { title: "Allen Iverson #291 Pink Ice Prizm", totalPrice: 1.69 },
      { title: "Allen Iverson #291 Wave Prizm", totalPrice: 3.32 },
      { title: "Allen Iverson #291 Red Prizm", totalPrice: 6 },
    ],
    strategy: "sold_comps_p25",
  });

  assert.equal(result.recommendedPrice, 51.87);
  assert.equal(result.evidence.activeFloor, 1.69);
  assert.equal(result.evidence.soldSerialFilterMode, "fallback_serialized");
});

test("real regression: doesn't anchor to an unrelated parallel's sold comp that only coincidentally shares the print run", () => {
  // Reproduces the live card_0123 bug: a raw "UNSTOPPABLE" /8 Eberechi Eze
  // Prizm recommended $206.50 from a single sold comp that was actually a
  // completely different parallel ("Lucky Envelopes"), PSA-graded, which
  // only happened to also be numbered /8. The active listings — the only
  // comps that actually named "Unstoppable" — sat near $1.
  const result = calculatePrice({
    strategy: "sold_comps_median",
    metadata: {
      parallel: "UNSTOPPABLE",
      baseHint: false,
      serialNumber: "8/8",
      printRun: 8,
    },
    soldComps: [
      { title: "Eberechi Eze 2024-25 Panini Prizm Premier League #160 Lucky Envelopes 8/8 PSA 10", totalPrice: 206.5 },
      { title: "2024-25 Panini Prizm Premier League - Eberechi Eze #160 Blue Ice Prizm /75", totalPrice: 5.07 },
      { title: "Panini Prizm Premier League 2024-25 Eberechi Eze Auto S-EZE", totalPrice: 30.48 },
    ],
    activeListings: [
      { title: "23-24 Panini Select EPL Unstoppable Eberechi Eze Silver Prizm", totalPrice: 0.99 },
    ],
  });

  assert.equal(result.recommendedPrice, 0.99);
  assert.ok(
    result.reason.includes("No sold comp confirmed this specific parallel"),
    `expected the unconfirmed-parallel reason, got: ${result.reason}`,
  );
  assert.equal(result.confidence, "low");
});

test("applyParallelFilterForPricing (via calculatePrice): baseHint no longer disables filtering when a real parallel is also present", () => {
  // Same setup as the regression above but with only the mismatched sold
  // comp available (no active data) — confirms the filter itself excludes
  // the wrong-parallel comp instead of falling back to "Insufficient sold
  // comps" via a silently-disabled filter mode.
  const result = calculatePrice({
    metadata: { parallel: "UNSTOPPABLE", baseHint: true, serialNumber: "8/8", printRun: 8 },
    soldComps: [
      { title: "Eberechi Eze 2024-25 Panini Prizm Premier League #160 Lucky Envelopes 8/8 PSA 10", totalPrice: 206.5 },
    ],
    activeListings: [],
  });

  assert.equal(result.evidence.soldParallelFilterMode, "parallel_not_found_all");
  assert.notEqual(result.evidence.soldParallelFilterMode, "disabled");
});

test("mergeDetectedMetadata: a confidently-detected specific parallel always clears baseHint, regardless of source", () => {
  // Reproduces the upstream data bug behind the card_0123 regression: an
  // earlier pass (or a different detector) had set baseHint true before
  // "UNSTOPPABLE" was confidently merged in as the parallel.
  const merged = mergeDetectedMetadata(
    { baseHint: true, parallel: null },
    { baseHint: false, parallel: "UNSTOPPABLE", playerName: "Eberechi Eze" },
    null,
  );
  assert.equal(merged.parallel, "UNSTOPPABLE");
  assert.equal(merged.baseHint, false);
});

test("mergeDetectedMetadata: baseHint stays true when the merged parallel is weak/generic (e.g. a bare color)", () => {
  const merged = mergeDetectedMetadata(
    { baseHint: true, parallel: null },
    { baseHint: true, parallel: "Silver", playerName: "Some Player" },
    null,
  );
  // "Silver" is a weak/generic parallel label (see isWeakParallelLabel) —
  // not specific enough to override an existing baseHint on its own.
  assert.equal(merged.baseHint, true);
});

test("mergeDetectedMetadata: prefers the year embedded in the set name when it conflicts with a separately-detected year", () => {
  // Reproduces the live card_0127 bug: front vision, back vision, and a
  // heuristic text scan each contributed a different field, landing on
  // year:2023 alongside setName:"2024 PANINI DONRUSS FOOTBALL" — a
  // self-contradictory pair that produced a comp-search query containing
  // BOTH years ("2023 Tee Higgins 2024 PANINI DONRUSS FOOTBALL...") and
  // found zero real sold matches for an otherwise common, liquid card.
  const merged = mergeDetectedMetadata(
    {},
    { year: 2023, setName: "2024 PANINI DONRUSS FOOTBALL", playerName: "Tee Higgins" },
    null,
  );
  assert.equal(merged.year, 2024);
  assert.equal(merged.setName, "2024 PANINI DONRUSS FOOTBALL");
});

test("mergeDetectedMetadata: keeps the detected year when the set name has no embedded year at all", () => {
  const merged = mergeDetectedMetadata(
    {},
    { year: 2023, setName: "Prizm", playerName: "Some Player" },
    null,
  );
  assert.equal(merged.year, 2023);
});

test("mergeDetectedMetadata: keeps the year when it already agrees with the set name's embedded year", () => {
  const merged = mergeDetectedMetadata(
    {},
    { year: 2024, setName: "2024 PANINI DONRUSS FOOTBALL", playerName: "Tee Higgins" },
    null,
  );
  assert.equal(merged.year, 2024);
});
