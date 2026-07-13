import test from "node:test";
import assert from "node:assert/strict";
import { apifyLookupCooldownMs, shouldSkipApifyLookup } from "../src/app.js";
import { buildApifyLookupKey } from "../src/services/apify.js";

// Real billed incident (2026-07-11): a card whose comp search genuinely
// finds zero results never satisfies the "already has a fresh comp price"
// skip condition (compPrice is never > 0), so the ONLY thing standing
// between it and a re-billed Apify run was a 15-minute attempted-at
// cooldown — far shorter than the actual retrigger cadence observed in
// production (hourly-ish). A fixed pool of ~15-20 genuinely comp-less cards
// re-fired real, billed runs for days as a result. A confirmed-empty result
// now gets a much longer cooldown via `card.apifyNoCompsFound`.

test("a card with no prior comp-less finding gets the short 15-minute cooldown", () => {
  assert.equal(apifyLookupCooldownMs({}), 15 * 60 * 1000);
  assert.equal(apifyLookupCooldownMs({ apifyNoCompsFound: false }), 15 * 60 * 1000);
  assert.equal(apifyLookupCooldownMs(null), 15 * 60 * 1000);
});

test("a card confirmed to have zero comps gets the long default cooldown (24h)", () => {
  const original = process.env.APIFY_NO_COMPS_COOLDOWN_MINUTES;
  delete process.env.APIFY_NO_COMPS_COOLDOWN_MINUTES;
  try {
    assert.equal(apifyLookupCooldownMs({ apifyNoCompsFound: true }), 24 * 60 * 60 * 1000);
  } finally {
    if (original === undefined) delete process.env.APIFY_NO_COMPS_COOLDOWN_MINUTES;
    else process.env.APIFY_NO_COMPS_COOLDOWN_MINUTES = original;
  }
});

test("the comp-less cooldown is configurable via APIFY_NO_COMPS_COOLDOWN_MINUTES", () => {
  const original = process.env.APIFY_NO_COMPS_COOLDOWN_MINUTES;
  process.env.APIFY_NO_COMPS_COOLDOWN_MINUTES = "60";
  try {
    assert.equal(apifyLookupCooldownMs({ apifyNoCompsFound: true }), 60 * 60 * 1000);
  } finally {
    if (original === undefined) delete process.env.APIFY_NO_COMPS_COOLDOWN_MINUTES;
    else process.env.APIFY_NO_COMPS_COOLDOWN_MINUTES = original;
  }
});

test("a non-positive or garbage cooldown env var falls back to a 1-minute floor, never 0", () => {
  const original = process.env.APIFY_NO_COMPS_COOLDOWN_MINUTES;
  for (const bad of ["0", "-5", "not-a-number", ""]) {
    process.env.APIFY_NO_COMPS_COOLDOWN_MINUTES = bad;
    assert.equal(apifyLookupCooldownMs({ apifyNoCompsFound: true }), 24 * 60 * 60 * 1000, `input: ${JSON.stringify(bad)}`);
  }
  if (original === undefined) delete process.env.APIFY_NO_COMPS_COOLDOWN_MINUTES;
  else process.env.APIFY_NO_COMPS_COOLDOWN_MINUTES = original;
});

// shouldSkipApifyLookup is the actual composed gate used by both live call
// sites (the reprice scheduler's computeReprice, and the Best Offers scan's
// per-listing comp lookup) — the reprice scheduler had NO gate of any kind
// before this fix and is confirmed (2026-07-11) as the dominant driver of a
// week of runaway spend, since it runs across every repriceable card on
// every scheduled tick regardless of whether that card has ever found a
// comp. hydrateExternalPricingSummary (a separate, currently-unreferenced
// queue-based hydration path) uses the same gate for consistency.
const METADATA = { playerName: "Dick Butkus", year: 1970, setName: "SUPER STARS", cardNumber: "", parallel: "" };
const LOOKUP_KEY = buildApifyLookupKey(METADATA);

test("shouldSkipApifyLookup: false for a card that has never been flagged comp-less", () => {
  assert.equal(shouldSkipApifyLookup({}, METADATA), false);
  assert.equal(shouldSkipApifyLookup(null, METADATA), false);
  assert.equal(
    shouldSkipApifyLookup({ apifyNoCompsFound: false, apifyLookupKey: LOOKUP_KEY }, METADATA),
    false,
  );
});

test("shouldSkipApifyLookup: true for a comp-less card whose identity is unchanged and cooldown hasn't cleared", () => {
  const card = {
    apifyNoCompsFound: true,
    apifyLookupKey: LOOKUP_KEY,
    externalCompLookupAttemptedAt: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
  };
  assert.equal(shouldSkipApifyLookup(card, METADATA), true);
});

test("shouldSkipApifyLookup: false once the cooldown window has elapsed", () => {
  const card = {
    apifyNoCompsFound: true,
    apifyLookupKey: LOOKUP_KEY,
    externalCompLookupAttemptedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25h ago
  };
  assert.equal(shouldSkipApifyLookup(card, METADATA), false);
});

test("shouldSkipApifyLookup: false when the card's identity changed since the comp-less attempt", () => {
  const card = {
    apifyNoCompsFound: true,
    apifyLookupKey: buildApifyLookupKey({ playerName: "Wrong Player" }),
    externalCompLookupAttemptedAt: new Date(Date.now() - 60_000).toISOString(),
  };
  // A corrected identity must get a fresh chance immediately, not wait out
  // a cooldown earned by the OLD (wrong) identity's empty result.
  assert.equal(shouldSkipApifyLookup(card, METADATA), false);
});

test("shouldSkipApifyLookup: false when there's no recorded attempt timestamp at all", () => {
  const card = { apifyNoCompsFound: true, apifyLookupKey: LOOKUP_KEY };
  assert.equal(shouldSkipApifyLookup(card, METADATA), false);
});
