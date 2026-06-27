import test from "node:test";
import assert from "node:assert/strict";
import { calculatePrice } from "../src/services/pricing.js";
import { choosePricingStrategy } from "../src/jobs/pipeline.js";

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
