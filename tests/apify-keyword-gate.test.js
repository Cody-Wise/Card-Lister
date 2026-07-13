import test from "node:test";
import assert from "node:assert/strict";
import { buildApifyKeywords } from "../src/services/apify.js";
import { buildOfferExternalCompLookupMetadata } from "../src/app.js";

// Real billed incident (2026-07-11): metadata carrying ONLY the rookie/
// autograph boolean flags — no player, year, or set — assembled into the
// literal Apify keywords "Rookie RC", "Autograph", and "Auto". Three real
// actor runs at ~$0.06 each (600x a targeted query), re-fired by every
// scheduled Best Offers scan while an offer sat pending on an untracked
// listing.

test("flags-only metadata produces NO keywords (no identity anchor, no spend)", () => {
  assert.deepEqual(buildApifyKeywords({ rookieFlag: true }), []);
  assert.deepEqual(buildApifyKeywords({ autographFlag: true }), []);
  assert.deepEqual(buildApifyKeywords({ rookieFlag: true, autographFlag: true, baseHint: true }), []);
  assert.deepEqual(buildApifyKeywords({}), []);
});

test("player-anchored metadata still produces keywords", () => {
  const keywords = buildApifyKeywords({
    playerName: "Kyler Murray",
    year: 2019,
    setName: "Donruss",
    cardNumber: "302",
  });
  assert.ok(keywords.length >= 1);
  assert.match(keywords[0], /Kyler Murray/);
});

test("set-anchored metadata (no player) is still allowed through", () => {
  const keywords = buildApifyKeywords({ setName: "Panini Prizm", year: 2023, rookieFlag: true });
  assert.ok(keywords.length >= 1);
  assert.match(keywords[0], /Panini Prizm/);
});

// The upstream fix: the card-less comp-lookup metadata builder used to
// hardcode identity fields empty, guaranteeing the flags-only shape above.
// It now parses the listing title.

test("offer comp-lookup metadata parses identity out of a real listing title", () => {
  const metadata = buildOfferExternalCompLookupMetadata(
    {},
    "2023 Panini Prizm Victor Wembanyama Silver Prizm #292 RC",
  );
  assert.equal(metadata.playerName, "Victor Wembanyama");
  assert.equal(metadata.year, 2023);
  assert.equal(metadata.setName, "Panini Prizm");
  assert.equal(metadata.cardNumber, "292");
  assert.equal(metadata.rookieFlag, true);
  // With identity present, the keyword gate stays open.
  assert.ok(buildApifyKeywords(metadata).length >= 1);
});

test("an unparseable title leaves identity empty — which the keyword gate then blocks", () => {
  const metadata = buildOfferExternalCompLookupMetadata({}, "HUGE LOT vintage cards RC AUTO look!!");
  assert.equal(metadata.playerName, "");
  assert.equal(metadata.setName, "");
  assert.equal(metadata.rookieFlag, true);
  assert.equal(metadata.autographFlag, true);
  assert.deepEqual(buildApifyKeywords(metadata), []);
});
