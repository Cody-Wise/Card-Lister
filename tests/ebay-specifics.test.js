import test from "node:test";
import assert from "node:assert/strict";
import {
  buildItemSpecificsForCard,
  stripEmptySpecifics,
  mapCondition,
  buildEBayTitleForCard,
  resolveCategoryIdForCard,
} from "../src/services/ebay.js";

// Defaults from getConfig() when the env vars aren't set — match eBay's real
// category IDs, so these tests exercise the same values production uses.
const SPORTS_CATEGORY_ID = "261328";
const TCG_CATEGORY_ID = "183454";
const NON_SPORT_CATEGORY_ID = "183050";

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

// Confirmed against a real eBay 400 rejection: the Sports Trading Card
// Singles category (261328) only accepts two top-level condition values —
// LIKE_NEW (Graded) or USED_VERY_GOOD (Ungraded) — regardless of the
// reviewer's selected physical grade. That grade goes in the condition
// descriptor (40001) instead; see buildItemSpecifics/createInventoryItem.
test("mapCondition always returns USED_VERY_GOOD for a raw card, whatever physical grade was selected", () => {
  assert.equal(mapCondition({ candidateGrade: "Near Mint or Better" }), "USED_VERY_GOOD");
  assert.equal(mapCondition({ candidateGrade: "Excellent" }), "USED_VERY_GOOD");
  assert.equal(mapCondition({ candidateGrade: "Very Good" }), "USED_VERY_GOOD");
  assert.equal(mapCondition({ candidateGrade: "Poor" }), "USED_VERY_GOOD");
});

test("mapCondition defaults to USED_VERY_GOOD when nothing was ever selected", () => {
  assert.equal(mapCondition({}), "USED_VERY_GOOD");
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

test("resolveCategoryIdForCard defaults a plain sports card to the sports category", () => {
  // Unlike the TCG/non-sport category ids (which have hardcoded fallbacks),
  // EBAY_CATEGORY_ID has no default in getConfig() — set it explicitly so
  // this test reflects real production config instead of the test
  // environment's unset value.
  const original = process.env.EBAY_CATEGORY_ID;
  process.env.EBAY_CATEGORY_ID = SPORTS_CATEGORY_ID;
  try {
    assert.equal(
      resolveCategoryIdForCard({ candidateSetName: "2019 Donruss Football" }),
      SPORTS_CATEGORY_ID
    );
  } finally {
    if (original === undefined) delete process.env.EBAY_CATEGORY_ID;
    else process.env.EBAY_CATEGORY_ID = original;
  }
});

test("resolveCategoryIdForCard trusts isTcgImport over sport/kind inference, even with no TCG keyword in the set name", () => {
  // No "pokemon"/"magic"/etc keyword anywhere, and no candidateSport set —
  // the old keyword-only inference would have silently fallen through to
  // the sports category here. isTcgImport is the explicit, permanent tab
  // membership flag and should win regardless.
  assert.equal(
    resolveCategoryIdForCard({ isTcgImport: true, candidateSetName: "2023 Series One" }),
    TCG_CATEGORY_ID
  );
});

test("resolveCategoryIdForCard picks the non-sport category for an isTcgImport card whose set name is clearly non-sport", () => {
  assert.equal(
    resolveCategoryIdForCard({ isTcgImport: true, candidateSetName: "Star Wars Chrome" }),
    NON_SPORT_CATEGORY_ID
  );
});

test("resolveCategoryIdForCard still honors an explicit manual ebayCategoryId override for a TCG-imported card", () => {
  assert.equal(
    resolveCategoryIdForCard({ isTcgImport: true, ebayCategoryId: "99999" }),
    "99999"
  );
});

test("resolveCategoryIdForCard falls back to keyword inference for non-TCG-tab cards (legacy behavior unchanged)", () => {
  assert.equal(
    resolveCategoryIdForCard({ candidateSetName: "Pokemon Scarlet & Violet" }),
    TCG_CATEGORY_ID
  );
});

test("buildItemSpecificsForCard sets Type to CCG Individual Card (not Sports Trading Card) for an isTcgImport card, even with no TCG keyword and an OCR-guessed sport", () => {
  const specifics = buildItemSpecificsForCard({
    isTcgImport: true,
    // OCR mis-tagged this — a real risk this session has already run into
    // for the sports-only pipeline. isTcgImport must win regardless.
    candidateSport: "Baseball",
    candidateSetName: "2023 Series One",
  });
  assert.deepEqual(specifics.Type, ["CCG Individual Card"]);
  assert.ok("Card Name" in specifics, "Trading Cards use Card Name, not Player/Athlete");
  assert.ok(!("Player/Athlete" in specifics));
});

test("buildItemSpecificsForCard still uses Non-Sport Trading Card for an isTcgImport card with a clear non-sport franchise keyword", () => {
  const specifics = buildItemSpecificsForCard({
    isTcgImport: true,
    candidateSetName: "Star Wars Chrome",
  });
  assert.deepEqual(specifics.Type, ["Non-Sport Trading Card"]);
});

test("buildItemSpecificsForCard keeps Sports Trading Card for a normal (non-TCG-tab) sports card", () => {
  const specifics = buildItemSpecificsForCard({
    candidateSport: "Baseball",
    candidateSetName: "2019 Topps",
  });
  assert.deepEqual(specifics.Type, ["Sports Trading Card"]);
});
