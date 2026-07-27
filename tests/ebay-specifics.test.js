import test from "node:test";
import assert from "node:assert/strict";
import {
  buildItemSpecificsForCard,
  stripEmptySpecifics,
  mapCondition,
  buildEBayTitleForCard,
  buildEBayDescriptionForCard,
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

test("buildItemSpecificsForCard recognizes Garbage Pail Kids as a Franchise value (real live 400: errorId 25002, Franchise missing)", () => {
  const specifics = buildItemSpecificsForCard({
    isTcgImport: true,
    candidateSetName: "Garbage Pail Kids",
  });
  assert.deepEqual(specifics.Type, ["Non-Sport Trading Card"]);
  assert.deepEqual(specifics.Franchise, ["Garbage Pail Kids"]);
});

test("buildItemSpecificsForCard falls back to the set name for Franchise when the kind is non_sport but no specific franchise keyword matches", () => {
  // "non-sport" itself is the generic bucket keyword (see
  // inferTradingCardKind) — Star Wars/Marvel/DC/Garbage Pail Kids are the
  // only specific franchises recognized, so anything else in that bucket
  // must still get a Franchise value rather than an omitted field.
  const specifics = buildItemSpecificsForCard({
    isTcgImport: true,
    candidateSetName: "1990 Non-Sport Trading Cards Wax Pack",
  });
  assert.deepEqual(specifics.Type, ["Non-Sport Trading Card"]);
  assert.deepEqual(specifics.Franchise, ["1990 Non-Sport Trading Cards Wax Pack"]);
});

test("buildItemSpecificsForCard defaults an isTcgImport card with a wholly ambiguous set name to CCG Individual Card with a Game value (not Non-Sport with no Franchise)", () => {
  // No tcg keyword, no non_sport keyword — kind is null. Type's CCG-biased
  // default for isTcgImport cards must stay consistent with which fallback
  // field (Game vs Franchise) actually gets populated, or the listing ends
  // up with a Type that doesn't match any populated required aspect.
  const specifics = buildItemSpecificsForCard({
    isTcgImport: true,
    candidateSetName: "Wacky Packages Series 12",
  });
  assert.deepEqual(specifics.Type, ["CCG Individual Card"]);
  assert.deepEqual(specifics.Game, ["Wacky Packages Series 12"]);
  assert.ok(!("Franchise" in specifics));
});

test("buildItemSpecificsForCard falls back to the set name for Game when no known TCG keyword matches", () => {
  const specifics = buildItemSpecificsForCard({
    isTcgImport: true,
    candidateSetName: "Flesh and Blood TCG",
  });
  assert.deepEqual(specifics.Game, ["Flesh and Blood TCG"]);
});

test("buildItemSpecificsForCard still uses the real game name for a recognized TCG keyword", () => {
  const specifics = buildItemSpecificsForCard({
    isTcgImport: true,
    candidateSetName: "Pokemon Scarlet & Violet",
  });
  assert.deepEqual(specifics.Game, ["Pokémon TCG"]);
});

// Real live 400 (2026-07-15, errorId 25002, "The item specific Game is
// missing") on "2020 Galaxy-Eyes Full Armor Photon Dragon #RA01-EN037" — a
// Yu-Gi-Oh card whose title/set/player never mention the game at all
// (normal for Yu-Gi-Oh, unlike Pokémon/MTG set names), AND whose set name
// was empty, so the old title/set/player/notes-only haystack plus the
// setName-only fallback both came up empty. Manufacturer had already
// correctly resolved to "Yu-Gi-Oh" via inferBrand — brand just wasn't part
// of the Game-detection signal.
test("buildItemSpecificsForCard recognizes hyphenated Yu-Gi-Oh via brand when title/set/player give no signal (real live 400)", () => {
  const specifics = buildItemSpecificsForCard({
    isTcgImport: true,
    candidatePlayer: "Galaxy-Eyes Full Armor Photon Dragon",
    candidateCardNumber: "RA01-EN037",
    candidateBrand: "Yu-Gi-Oh",
    // candidateSetName intentionally omitted — empty on the real card.
  });
  assert.deepEqual(specifics.Type, ["CCG Individual Card"]);
  assert.deepEqual(specifics.Manufacturer, ["Yu-Gi-Oh"]);
  assert.deepEqual(specifics.Game, ["Yu-Gi-Oh!"]);
});

test("buildItemSpecificsForCard falls back to brand for Game when both title/set/player and set name give no signal", () => {
  const specifics = buildItemSpecificsForCard({
    isTcgImport: true,
    candidateBrand: "Some Obscure TCG Brand",
    // No candidateSetName, no recognized keyword anywhere.
  });
  assert.deepEqual(specifics.Game, ["Some Obscure TCG Brand"]);
});

// The description used to hardcode "Raw / Near Mint-Mint" for EVERY ungraded
// card, so the reviewer's condition selection never reached the listing copy
// — a genuinely worn card was described as near mint. Same class of bug as
// the condition-descriptor one fixed earlier, and it meant the structured
// eBay field and the human-readable copy contradicted each other on the same
// listing.
test("the description reflects the reviewer's selected raw condition", async () => {
  const base = {
    candidatePlayer: "Willie Mays",
    candidateYear: 2013,
    candidateSetName: "Topps Baseball",
    candidateCardNumber: "305",
    candidateCondition: "raw",
  };
  const conditionLine = async (grade) => {
    const description = await buildEBayDescriptionForCard({ ...base, candidateGrade: grade }, { force: true });
    return (description.match(/Condition: [^\n]*/) || [""])[0];
  };
  assert.equal(await conditionLine("Poor"), "Condition: Raw / Poor");
  assert.equal(await conditionLine("Very Good"), "Condition: Raw / Very Good");
  assert.equal(await conditionLine("Excellent"), "Condition: Raw / Excellent");
  assert.equal(await conditionLine("Near Mint or Better"), "Condition: Raw / Near Mint or Better");
});

test("a graded card still describes grader + grade, not the raw wording", async () => {
  const description = await buildEBayDescriptionForCard(
    {
      candidatePlayer: "Willie Mays",
      candidateYear: 2013,
      candidateSetName: "Topps Baseball",
      candidateCondition: "graded",
      gradingCompany: "PSA",
      candidateGrade: "10",
    },
    { force: true },
  );
  assert.match(description, /Condition: PSA 10/);
  assert.doesNotMatch(description, /Raw \//);
});

test("with no condition selected the description falls back to the prior wording", async () => {
  const description = await buildEBayDescriptionForCard(
    { candidatePlayer: "Willie Mays", candidateYear: 2013, candidateSetName: "Topps Baseball", candidateCondition: "raw" },
    { force: true },
  );
  assert.match(description, /Condition: Raw \/ Near Mint-Mint/);
});

test("print run and serial reach the description copy", async () => {
  const description = await buildEBayDescriptionForCard(
    {
      candidatePlayer: "Willie Mays",
      candidateYear: 2013,
      candidateSetName: "Topps Baseball",
      printRun: 25,
      serialNumber: "07/25",
    },
    { force: true },
  );
  assert.match(description, /Print Run: 25/);
  assert.match(description, /Serial Numbered: 07\/25/);
});
