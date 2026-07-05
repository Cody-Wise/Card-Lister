import test from "node:test";
import assert from "node:assert/strict";
import { buildConditionDescriptors, resolveGraderAndGrade } from "../src/services/ebay-condition.js";

const SPORTS_CATEGORY_ID = "261328";
const opts = { categoryId: SPORTS_CATEGORY_ID, sportsCategoryId: SPORTS_CATEGORY_ID };

test("resolves grader and grade from CardLister's structured fields", () => {
  assert.deepEqual(
    resolveGraderAndGrade({ gradingCompany: "PSA", candidateGrade: "PSA 10" }),
    { grader: "PSA", grade: "10" }
  );
  // gradingCompany absent — falls back to parsing the combined grade text.
  assert.deepEqual(
    resolveGraderAndGrade({ candidateGrade: "SGC 9.5" }),
    { grader: "SGC", grade: "9.5" }
  );
});

test("builds descriptors for a graded card in the validated sports category", () => {
  const descriptors = buildConditionDescriptors(
    { candidateCondition: "graded", gradingCompany: "PSA", candidateGrade: "PSA 10", certificationNumber: "84523671" },
    opts
  );
  assert.equal(descriptors.length, 3);
  assert.deepEqual(descriptors[0], { name: "27501", values: ["275010"] });
  assert.deepEqual(descriptors[1], { name: "27502", values: ["275020"] });
  assert.deepEqual(descriptors[2], { name: "27503", additionalInfo: "84523671" });
});

test("omits descriptors for an unvalidated category (e.g. TCG/non-sport)", () => {
  const descriptors = buildConditionDescriptors(
    { candidateCondition: "graded", gradingCompany: "PSA", candidateGrade: "PSA 10" },
    { categoryId: "183454", sportsCategoryId: SPORTS_CATEGORY_ID }
  );
  assert.deepEqual(descriptors, []);
});

test("fails safe for PSA paired with a half-point grade", () => {
  assert.deepEqual(
    buildConditionDescriptors({ candidateCondition: "graded", gradingCompany: "PSA", candidateGrade: "PSA 9.5" }, opts),
    []
  );
});

test("fails safe when grader or grade cannot be resolved", () => {
  assert.deepEqual(buildConditionDescriptors({ candidateCondition: "graded", candidateGrade: "10" }, opts), []);
});

test("returns nothing for ungraded cards", () => {
  assert.deepEqual(buildConditionDescriptors({ candidateCondition: "raw" }, opts), []);
});

test("omits an over-length certification number rather than sending an invalid value", () => {
  const descriptors = buildConditionDescriptors(
    {
      candidateCondition: "graded",
      gradingCompany: "PSA",
      candidateGrade: "PSA 10",
      // eBay's real documented limit for 27503 is 30 chars — this is 31.
      certificationNumber: "1234567890123456789012345678901"
    },
    opts
  );
  assert.equal(descriptors.length, 2);
});
