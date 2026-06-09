import test from "node:test";
import assert from "node:assert/strict";
import { calculatePrice } from "../src/services/pricing.js";
import { choosePricingStrategy } from "../src/jobs/pipeline.js";

test("prices from sold comps with trimming", () => {
  const result = calculatePrice({
    soldComps: [
      { totalPrice: 10 },
      { totalPrice: 11 },
      { totalPrice: 12 },
      { totalPrice: 40 }
    ],
    activeListings: [{ price: 15 }]
  });
  assert.ok(result.recommendedPrice > 0);
  assert.equal(result.soldCompCount, 4);
  assert.equal(result.usedSoldCompCount, 3);
  assert.equal(result.evidence.sold.length, 3);
});

test("blends up when active listings are hot", () => {
  const result = calculatePrice({
    soldComps: [
      { totalPrice: 10 },
      { totalPrice: 11 },
      { totalPrice: 12 }
    ],
    activeListings: [
      { price: 20 },
      { price: 22 },
      { price: 24 }
    ]
  });

  assert.ok(result.recommendedPrice > 11);
  assert.ok(result.recommendedPrice < 24);
  assert.ok(result.reason.includes("active listings are hot") || result.reason.includes("light active-listing check"));
});

test("stays anchored when active listings are only mildly above sold comps", () => {
  const result = calculatePrice({
    soldComps: [
      { totalPrice: 2.99 },
      { totalPrice: 3.05 },
      { totalPrice: 3.12 }
    ],
    activeListings: [
      { price: 4.00 },
      { price: 4.10 },
      { price: 4.20 },
      { price: 4.30 }
    ]
  });

  assert.ok(result.recommendedPrice >= 2.9);
  assert.ok(result.recommendedPrice <= 3.2);
  assert.ok(!result.reason.includes("active listings are hot"));
});

test("keeps numbered cards conservative unless the variant is also known", () => {
  assert.equal(
    choosePricingStrategy({ printRun: 75 }),
    "sold_comps_p25"
  );
  assert.equal(
    choosePricingStrategy({ serialNumber: "002/150" }),
    "sold_comps_p25"
  );
  assert.equal(
    choosePricingStrategy({ serialNumber: "002/150", parallel: "Blue Refractor" }),
    "sold_comps_median"
  );
  assert.equal(
    choosePricingStrategy({}),
    "sold_comps_p25"
  );
});
