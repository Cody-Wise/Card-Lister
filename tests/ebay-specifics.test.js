import test from "node:test";
import assert from "node:assert/strict";
import {
  buildItemSpecificsForCard,
  stripEmptySpecifics,
  mapCondition,
  buildEBayTitleForCard,
} from "../src/services/ebay.js";

test("buildItemSpecificsForCard still includes an empty row for undetected core fields (editable preview table)", () => {
  const specifics = buildItemSpecificsForCard({
    // No candidateSport/candidatePlayer/etc. detected at all.
    candidateCardNumber: "45",
  });

  assert.ok("Sport" in specifics, "Sport row must exist even when undetected so it stays editable");
  assert.deepEqual(specifics.Sport, [""]);
  assert.ok("Player/Athlete" in specifics);
  assert.deepEqual(specifics["Player/Athlete"], [""]);
});

test("stripEmptySpecifics drops empty-value specifics before real eBay submission", () => {
  const specifics = buildItemSpecificsForCard({
    candidateCardNumber: "45",
  });
  const stripped = stripEmptySpecifics(specifics);

  assert.ok(!("Sport" in stripped), "blank Sport must not be sent to eBay's real API");
  assert.ok(!("Player/Athlete" in stripped));
  assert.equal(stripped["Card Number"][0], "45");
});

test("stripEmptySpecifics keeps a real detected value", () => {
  const specifics = buildItemSpecificsForCard({
    candidateSport: "Basketball",
    candidatePlayer: "Victor Wembanyama",
  });
  const stripped = stripEmptySpecifics(specifics);

  assert.deepEqual(stripped.Sport, ["Basketball"]);
  assert.deepEqual(stripped["Player/Athlete"], ["Victor Wembanyama"]);
});

test("mapCondition reflects the reviewer's selected raw condition instead of always Near Mint", () => {
  assert.equal(mapCondition({ candidateGrade: "Near Mint or Better" }), "LIKE_NEW");
  assert.equal(mapCondition({ candidateGrade: "Excellent" }), "USED_EXCELLENT");
  assert.equal(mapCondition({ candidateGrade: "Very Good" }), "USED_VERY_GOOD");
  assert.equal(mapCondition({ candidateGrade: "Poor" }), "USED_ACCEPTABLE");
});

test("mapCondition defaults to Near Mint or Better when nothing was ever selected", () => {
  assert.equal(mapCondition({}), "LIKE_NEW");
});

test("mapCondition ignores the raw-condition grade for a graded card", () => {
  assert.equal(mapCondition({ candidateCondition: "graded", candidateGrade: "Poor" }), "LIKE_NEW");
});

test("buildEBayTitleForCard includes the grader alongside the grade for a graded card", () => {
  const title = buildEBayTitleForCard({
    candidateYear: 2019,
    candidateSetName: "Donruss",
    candidatePlayer: "Kyler Murray",
    candidateCardNumber: "302",
    candidateCondition: "graded",
    candidateGrade: "10",
    gradingCompany: "PSA",
  });
  assert.ok(title.includes("PSA 10"), `expected "PSA 10" in title, got: ${title}`);
});

test("buildEBayTitleForCard infers the grader from the grade text when gradingCompany isn't set", () => {
  const title = buildEBayTitleForCard({
    candidateYear: 2019,
    candidateSetName: "Donruss",
    candidatePlayer: "Kyler Murray",
    candidateCondition: "graded",
    candidateGrade: "PSA 10",
  });
  assert.ok(title.includes("PSA 10"), `expected "PSA 10" in title, got: ${title}`);
  assert.ok(!title.includes("PSA PSA"), `grader must not be duplicated, got: ${title}`);
});

test("buildEBayTitleForCard falls back to '<grader> Graded' when graded with no grade number", () => {
  const title = buildEBayTitleForCard({
    candidateYear: 2019,
    candidateSetName: "Donruss",
    candidatePlayer: "Kyler Murray",
    candidateCondition: "graded",
    gradingCompany: "BGS",
  });
  assert.ok(title.includes("BGS Graded"), `expected "BGS Graded" in title, got: ${title}`);
});

test("buildEBayTitleForCard doesn't add a grader for an ungraded (raw) card", () => {
  const title = buildEBayTitleForCard({
    candidateYear: 2019,
    candidateSetName: "Donruss",
    candidatePlayer: "Kyler Murray",
    candidateCardNumber: "302",
    candidateGrade: "Near Mint or Better",
  });
  assert.ok(!title.includes("PSA"), `raw card title shouldn't mention a grader, got: ${title}`);
  assert.ok(title.includes("Near Mint or Better"), `expected raw condition text in title, got: ${title}`);
});
