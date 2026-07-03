import test from "node:test";
import assert from "node:assert/strict";
import { normalizeXimilarPayload, normalizeXimilarTcgPayload } from "../src/services/ximilar.js";

// Captured from a real call to https://api.ximilar.com/collectibles/v2/sport_id
// against a real (ungraded) 1991 SkyBox Michael Jordan #583 card photo, using
// slab_id/slab_grade:true. best_match came back null for this card — Ximilar's
// database didn't have a confident direct match — but the top `alternative`
// (lowest distance) was in fact the correct card, confirming the fallback
// path is worth surfacing even at reduced confidence.
const REAL_NO_BEST_MATCH_RESPONSE = {
  records: [
    {
      _status: { code: 200, text: "OK", request_id: "0f9c9c4b-5147-419a-9e72-ab166e8e1cae" },
      _id: "0defe6b9-c2f4-46cf-8f3c-6068342a4c94",
      Category: "Card/Sport Card",
      _objects: [
        {
          name: "Card",
          prob: 0.8180104494094849,
          _tags: {
            Side: [{ prob: 0.9732, name: "front" }],
            Subcategory: [{ prob: 0.69872, name: "Basketball" }],
            Autograph: [{ prob: 0.97152, name: "not signed" }],
            "Foil/Holo": [{ prob: 0.95138, name: "Foil/Holo" }],
            Graded: [{ prob: 0.87867, name: "no" }],
          },
          _identification: {
            best_match: null,
            alternatives: [
              {
                name: "Michael Jordan",
                card_number: "583",
                set_name: "SkyBox",
                year: "1991",
                team: "Chicago Bulls",
                subcategory: "Basketball",
                company: "SkyBox",
                full_name: "Michael Jordan 1991 #583 SkyBox",
              },
              {
                name: "Shaquille O'Neal",
                sub_set: "Genuine Article Insider",
                card_number: "GA-SO",
                card_type: "Memorabilia",
                set_name: "Genuine Insider",
                year: "2003",
                team: "Los Angeles Lakers",
                subcategory: "Basketball",
                serial_number: "400",
                company: "Fleer",
              },
            ],
            distances: [0.4552264, 0.57991624],
          },
        },
      ],
      "Graded Slab": [{ prob: 0.87867, name: "no" }],
    },
  ],
  status: { code: 200, text: "OK" },
};

// Captured from a real call against a real PSA 10 graded slab (2019 Panini
// Score Kyler Murray #384, PSA cert 44106187), using slab_id/slab_grade:true.
// Confirms the "Slab Label" object (separate from "Card" in _objects) is
// where gradingCompany/grade/certificationNumber actually live — every field
// below matched the physical slab exactly.
const REAL_GRADED_SLAB_RESPONSE = {
  records: [
    {
      _status: { code: 200, text: "OK" },
      _objects: [
        {
          name: "Card",
          prob: 0.926699697971344,
          _tags: {
            Subcategory: [{ prob: 0.88477, name: "Football" }],
            Autograph: [{ prob: 0.98983, name: "not signed" }],
            Graded: [{ prob: 0.9839, name: "yes" }],
          },
          _identification: {
            best_match: {
              team: "Oklahoma Sooners",
              year: "2019",
              card_type: "Rookie Card",
              card_number: "384",
              set_name: "Score",
              name: "Kyler Murray",
              subcategory: "Football",
              company: "Panini",
              full_name: "Kyler Murray 2019 #384 Panini Score",
            },
            alternatives: [],
          },
        },
        {
          name: "Slab Label",
          prob: 0.8653231859207153,
          _tags: {
            Company: [{ prob: 0.98292, name: "PSA" }],
            Grade: [{ prob: 0.99516, name: "10" }],
            Graded: [{ prob: 0.9839, name: "yes" }],
          },
          _ocr: {
            full_text: "#384 2019 PANINI SCORE KYLER MURRAY GEMMT 10 44106187",
          },
          _identification: {
            best_match: {
              name: "KYLER MURRAY",
              brand: "PANINI",
              verbal_grade: "gemmt",
              grade: "10",
              year: "2019",
              card_no: "#384",
              certificate_number: "44106187",
              set: "SCORE",
            },
          },
        },
      ],
      "Graded Slab": [{ prob: 0.9839, name: "yes" }],
    },
  ],
};

test("extracts grader/grade/cert number from the Slab Label object on a real graded card", () => {
  const result = normalizeXimilarPayload(REAL_GRADED_SLAB_RESPONSE);
  assert.equal(result.playerName, "Kyler Murray");
  assert.equal(result.year, 2019);
  assert.equal(result.setName, "Score");
  assert.equal(result.cardNumber, "384");
  assert.equal(result.team, "Oklahoma Sooners");
  assert.equal(result.sport, "football");
  assert.equal(result.gradedFlag, true);
  assert.equal(result.rookieFlag, true);
  assert.equal(result.gradingCompany, "PSA");
  assert.equal(result.grade, "10");
  assert.equal(result.certificationNumber, "44106187");
});

test("falls back to the top alternative with reduced confidence when there's no best_match", () => {
  const result = normalizeXimilarPayload(REAL_NO_BEST_MATCH_RESPONSE);
  assert.equal(result.playerName, "Michael Jordan");
  assert.equal(result.year, 1991);
  assert.equal(result.setName, "SkyBox");
  assert.equal(result.cardNumber, "583");
  assert.equal(result.team, "Chicago Bulls");
  assert.equal(result.sport, "basketball");
  assert.equal(result.gradedFlag, false);
  assert.equal(result.autographFlag, false);
  assert.equal(result.provider, "ximilar");
  // Alternative-based match should be visibly less confident than a real best_match.
  assert.ok(result.confidence < 0.5, `expected reduced confidence, got ${result.confidence}`);
  assert.match(result.notes, /no confident catalog match/);
});

test("uses best_match directly and at higher confidence when present", () => {
  const payload = {
    records: [
      {
        _objects: [
          {
            prob: 0.9,
            _tags: {
              Autograph: [{ name: "signed" }],
              Graded: [{ name: "no" }],
            },
            _identification: {
              best_match: {
                name: "Victor Wembanyama",
                year: "2023",
                set_name: "Prizm",
                card_number: "1",
                team: "San Antonio Spurs",
                subcategory: "Basketball",
                card_type: "Rookie Card",
                sub_set: "Silver",
              },
              alternatives: [],
            },
          },
        ],
      },
    ],
  };
  const result = normalizeXimilarPayload(payload);
  assert.equal(result.playerName, "Victor Wembanyama");
  assert.equal(result.year, 2023);
  assert.equal(result.rookieFlag, true);
  assert.equal(result.variantLabel, "Rookie Card");
  // sub_set is Ximilar's parallel/colorway field — must stay separate from
  // the rookie-label variantLabel so it can actually be compared against
  // another parallel source (e.g. an OpenAI verification pass).
  assert.equal(result.parallel, "Silver");
  assert.equal(result.autographFlag, true);
  assert.equal(result.confidence, 0.9);
  assert.match(result.notes, /catalog best match/);
});

test("returns a graceful empty result when no card is detected", () => {
  const result = normalizeXimilarPayload({ records: [{ _objects: [] }] });
  assert.equal(result.playerName, null);
  assert.equal(result.confidence, 0);
  assert.equal(result.provider, "ximilar");
  assert.match(result.notes, /no card detected/);
});

test("maps a bare serial_number to printRun rather than a specific serial", () => {
  const payload = {
    records: [
      {
        _objects: [
          {
            prob: 0.7,
            _tags: {},
            _identification: {
              best_match: {
                name: "Test Player",
                serial_number: "150",
              },
              alternatives: [],
            },
          },
        ],
      },
    ],
  };
  const result = normalizeXimilarPayload(payload);
  assert.equal(result.printRun, 150);
  assert.equal(result.serialNumber, null);
});

test("handles a totally empty payload without throwing", () => {
  const result = normalizeXimilarPayload({});
  assert.equal(result.playerName, null);
  assert.equal(result.confidence, 0);
});

// tcg_id shares sport_id's overall shape (records/_objects/_identification/
// _tags) per https://docs.ximilar.com/collectibles/recognition, but
// best_match fields describe a trading card game entry (name/set/set_code/
// rarity/card_number/series) instead of a sports card.
test("normalizes a tcg_id best_match into the same card-metadata shape sport_id uses", () => {
  const payload = {
    records: [
      {
        _status: { code: 200, text: "OK" },
        _objects: [
          {
            name: "Card",
            prob: 0.93,
            _tags: {
              Subcategory: [{ prob: 0.98, name: "Pokemon" }],
              Graded: [{ prob: 0.9, name: "no" }],
              Autograph: [{ prob: 0.95, name: "not signed" }],
            },
            _identification: {
              best_match: {
                name: "Charizard",
                full_name: "Charizard - Base Set - 4/102",
                set: "Base Set",
                set_code: "BS",
                card_number: "4/102",
                rarity: "Holo Rare",
                series: "Base",
                color: "Fire",
                type: "Stage 2",
                year: "1999",
              },
              alternatives: [],
            },
          },
        ],
      },
    ],
  };
  const result = normalizeXimilarTcgPayload(payload);
  assert.equal(result.playerName, "Charizard");
  assert.equal(result.setName, "Base Set");
  assert.equal(result.cardNumber, "4/102");
  assert.equal(result.parallel, "Holo Rare");
  assert.equal(result.team, "Base");
  assert.equal(result.sport, "Pokemon");
  assert.equal(result.year, 1999);
  assert.equal(result.gradedFlag, false);
  assert.equal(result.autographFlag, false);
  assert.equal(result.provider, "ximilar");
  assert.equal(result.confidence, 0.93);
  assert.match(result.notes, /catalog best match/);
});

test("falls back to the top tcg_id alternative with reduced confidence when there's no best_match", () => {
  const payload = {
    records: [
      {
        _objects: [
          {
            prob: 0.8,
            _tags: { Subcategory: [{ name: "Magic: The Gathering" }] },
            _identification: {
              best_match: null,
              alternatives: [{ name: "Black Lotus", set: "Alpha", card_number: "232" }],
              distances: [0.51],
            },
          },
        ],
      },
    ],
  };
  const result = normalizeXimilarTcgPayload(payload);
  assert.equal(result.playerName, "Black Lotus");
  assert.equal(result.setName, "Alpha");
  assert.equal(result.sport, "Magic: The Gathering");
  assert.ok(result.confidence < 0.5, `expected reduced confidence, got ${result.confidence}`);
  assert.match(result.notes, /no confident catalog match/);
});

test("extracts slab fields from a graded tcg_id response the same way sport_id does", () => {
  const payload = {
    records: [
      {
        _objects: [
          {
            name: "Card",
            prob: 0.9,
            _tags: { Subcategory: [{ name: "Pokemon" }], Graded: [{ name: "yes" }] },
            _identification: {
              best_match: { name: "Pikachu", set: "Base Set", card_number: "58/102" },
              alternatives: [],
            },
          },
          {
            name: "Slab Label",
            prob: 0.85,
            _tags: { Company: [{ name: "PSA" }] },
            _identification: { best_match: { grade: "9", certificate_number: "12345678" } },
          },
        ],
      },
    ],
  };
  const result = normalizeXimilarTcgPayload(payload);
  assert.equal(result.playerName, "Pikachu");
  assert.equal(result.gradedFlag, true);
  assert.equal(result.gradingCompany, "PSA");
  assert.equal(result.grade, "9");
  assert.equal(result.certificationNumber, "12345678");
});

test("returns a graceful empty result for a tcg_id payload with no card detected", () => {
  const result = normalizeXimilarTcgPayload({ records: [{ _objects: [] }] });
  assert.equal(result.playerName, null);
  assert.equal(result.confidence, 0);
  assert.equal(result.provider, "ximilar");
  assert.match(result.notes, /no card detected/);
});
