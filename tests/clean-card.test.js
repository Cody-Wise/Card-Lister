import test from "node:test";
import assert from "node:assert/strict";
import { cleanCard } from "../src/app.js";

// Real reported bug: the review panel's grade dropdown showed blank/first-
// option for a graded card even though card.candidateGrade held a real
// value — reviewGrade.value = card.candidateGrade only works when that
// string is a character-for-character match against one of the dropdown's
// "PSA 10"-style option values. cleanCard() now also computes
// gradeDropdownValue via the same grader/grade parser eBay's own condition
// descriptors use, so the frontend can fall back to a reliably-normalized
// value instead of requiring OCR text to already be in the exact right shape.

test("cleanCard computes gradeDropdownValue for a cleanly-formatted graded card", () => {
  const result = cleanCard({
    candidateCondition: "graded",
    gradingCompany: "PSA",
    candidateGrade: "PSA 10",
  });
  assert.equal(result.gradeDropdownValue, "PSA 10");
});

test("cleanCard still reconstructs gradeDropdownValue when candidateGrade is a bare number with no grader prefix", () => {
  // gradingCompany carries the grader here — candidateGrade alone wouldn't
  // character-match any dropdown option ("10" isn't an option; "PSA 10" is).
  const result = cleanCard({
    candidateCondition: "graded",
    gradingCompany: "PSA",
    candidateGrade: "10",
  });
  assert.equal(result.gradeDropdownValue, "PSA 10");
});

test("cleanCard normalizes a BECKETT grader to BGS to match the dropdown's actual optgroup", () => {
  const result = cleanCard({
    candidateCondition: "graded",
    gradingCompany: "Beckett",
    candidateGrade: "Beckett 9.5",
  });
  assert.equal(result.gradeDropdownValue, "BGS 9.5");
});

test("cleanCard leaves gradeDropdownValue null for a raw (non-graded) card", () => {
  const result = cleanCard({ candidateCondition: "raw", candidateGrade: "Near Mint or Better" });
  assert.equal(result.gradeDropdownValue, null);
});

test("cleanCard leaves gradeDropdownValue null when a graded card has no parseable grader/grade at all", () => {
  const result = cleanCard({ candidateCondition: "graded", candidateGrade: null, gradingCompany: null });
  assert.equal(result.gradeDropdownValue, null);
});

test("cleanCard still preserves every other card field via the existing shallow spread", () => {
  const result = cleanCard({ id: "card_0001", candidatePlayer: "Test Player", status: "needs_review" });
  assert.equal(result.id, "card_0001");
  assert.equal(result.candidatePlayer, "Test Player");
});
