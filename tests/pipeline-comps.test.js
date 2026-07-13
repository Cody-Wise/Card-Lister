import test from "node:test";
import assert from "node:assert/strict";
import {
  isRelevantComp,
  needsBatchProcessing,
  inferMetadataFromTitle,
  describeBatchProcessingState,
  normalizeStoredComp,
} from "../src/jobs/pipeline.js";

test("rejects comps from a different year even when player and set tokens both match", () => {
  // Real production case (2026-07-04): a 2024 Luka Doncic Donruss Optic card
  // had its autographFlag/cardNumber silently corrupted because these three
  // comps — all genuinely different cards (2021-22 and 2018-19, entirely
  // different Donruss sub-brands) — passed the relevance filter: player name
  // matched trivially, none had an extractable card number to reject on, and
  // "Donruss" alone satisfied the set-token check regardless of year or
  // sub-brand (Optic vs Elite vs base).
  const metadata = { playerName: "Luka Doncic", year: 2024, setName: "Donruss", cardNumber: "1" };
  const mismatchedComps = [
    { title: "2021-22 Panini Donruss Optic LUKA DONCIC Opti-Graphs CHOICE AUTO On-Card" },
    { title: "2021-2022 PANINI DONRUSS ELITE LUKA DONCIC  ELITE ON-CARD AUTO 98/99" },
    { title: "2018-19 Panini Donruss Luka Doncic Rookie Dominator Signatures RC Auto #/99" },
  ];
  for (const comp of mismatchedComps) {
    assert.equal(isRelevantComp(comp, metadata), false, `should reject: ${comp.title}`);
  }
});

test("still accepts a comp whose year genuinely matches", () => {
  const metadata = { playerName: "Luka Doncic", year: 2024, setName: "Donruss", cardNumber: "1" };
  const comp = { title: "2024-25 Panini Donruss Optic Luka Doncic #1 Splash!" };
  assert.equal(isRelevantComp(comp, metadata), true);
});

test("does not reject a comp when the title has no extractable year at all", () => {
  // Weak-match-passes-through is intentional (mirrors compMatchesCardNumber/
  // compMatchesSet) — don't over-reject just because a title happens to omit
  // a year, only reject a confirmed mismatch.
  const metadata = { playerName: "Luka Doncic", year: 2024, setName: "Donruss", cardNumber: "1" };
  const comp = { title: "Luka Doncic Donruss Optic Splash! #1" };
  assert.equal(isRelevantComp(comp, metadata), true);
});

test("does not reject anything when the card's own year is unknown", () => {
  const metadata = { playerName: "Luka Doncic", setName: "Donruss", cardNumber: "1" };
  const comp = { title: "2021-22 Panini Donruss Optic LUKA DONCIC Opti-Graphs CHOICE AUTO On-Card" };
  assert.equal(isRelevantComp(comp, metadata), true);
});

// --- isRelevantComp: parallel -----------------------------------------------
// Real production case (2026-07-13): a Dereck Lively II card whose own
// parallel is Blue Refractor/Teal Lazer had its comp list padded with
// "Green Lazer #/175", "Red Cracked Ice", "Blue Cracked Ice Prizm", and a
// plain unparalleled base comp — none of them the card's actual parallel —
// because isRelevantComp never checked parallel at all, only player/year/
// set/card#, all of which those comps happened to satisfy.

test("rejects a comp naming a different parallel than the card's own", () => {
  const metadata = { playerName: "Dereck Lively II", year: 2023, setName: "Phoenix Basketball", cardNumber: "290", parallel: "Blue Refractor" };
  const mismatchedComps = [
    { title: "2023-24 Panini Phoenix #290 Dereck Lively II Phoenix Green Lazer #/175" },
    { title: "DERECK LIVELY II 2023-24 PANINI PHOENIX RED CRACKED ICE ROOKIE #290 Q7084" },
    { title: "2023-24 Panini Phoenix DERECK LIVELY II RC Blue Cracked Ice Prizm – Mavericks RC" },
  ];
  for (const comp of mismatchedComps) {
    assert.equal(isRelevantComp(comp, metadata), false, `should reject: ${comp.title}`);
  }
});

test("rejects a comp with no parallel signal at all when the card has a specific parallel", () => {
  const metadata = { playerName: "Dereck Lively II", year: 2023, setName: "Phoenix Basketball", cardNumber: "290", parallel: "Blue Refractor" };
  const comp = { title: "2023-24 Panini Phoenix Basketball Dereck Lively II #290 RC Mavericks Rookie" };
  assert.equal(isRelevantComp(comp, metadata), false);
});

test("accepts a comp whose title genuinely names the card's own parallel", () => {
  const metadata = { playerName: "Dereck Lively II", year: 2023, setName: "Phoenix Basketball", cardNumber: "290", parallel: "Blue Refractor" };
  const comp = { title: "2023-24 Panini Phoenix Dereck Lively II Blue Refractor #290 RC" };
  assert.equal(isRelevantComp(comp, metadata), true);
});

test("does not require a parallel signal on the comp when the card itself has no parallel (base card)", () => {
  const metadata = { playerName: "Dereck Lively II", year: 2023, setName: "Phoenix Basketball", cardNumber: "290", parallel: "" };
  const comp = { title: "2023-24 Panini Phoenix Basketball Dereck Lively II #290 RC Mavericks Rookie" };
  assert.equal(isRelevantComp(comp, metadata), true);
});

// --- normalizeStoredComp -----------------------------------------------------
// Real production bug (2026-07-13): writeCardResult derived a comp's stored
// `source` from `comp.kind === "sold"`, but normalizeSoldListing (apify.js)
// — the primary sold-comp path whenever Apify is configured — never sets a
// `kind` field at all, so every real sold comp was mislabeled "browse_active"
// and duplicated into the "active listings" list. `listingId: comp.id` was
// also wrong — none of the comp-normalizer shapes use `.id`, only
// `.listingId`.

test("a sold comp with no kind field (the real apify.js shape) keeps its real source", () => {
  const apifySoldComp = {
    source: "apify_sold_listings",
    listingId: "376661333183",
    title: "2023-24 Panini Phoenix Basketball Dereck Lively II #290 RC Mavericks Rookie",
    salePrice: 2.89,
    totalPrice: 20.21,
  };
  const stored = normalizeStoredComp(apifySoldComp, apifySoldComp.source || "sold");
  assert.equal(stored.source, "apify_sold_listings");
  assert.equal(stored.listingId, "376661333183");
});

test("an active-listing comp always gets browse_active regardless of its own fields", () => {
  const activeComp = { listingId: "v1|366406063307|0", title: "Some active listing", totalPrice: 1.68 };
  const stored = normalizeStoredComp(activeComp, "browse_active");
  assert.equal(stored.source, "browse_active");
  assert.equal(stored.listingId, "v1|366406063307|0");
});

test("listingId comes from comp.listingId, not comp.id (which none of the comp shapes set)", () => {
  const comp = { id: "should-not-be-used", listingId: "real-listing-id", title: "x" };
  const stored = normalizeStoredComp(comp, "sold");
  assert.equal(stored.listingId, "real-listing-id");
});

// --- needsBatchProcessing ----------------------------------------------------
// Real production incident, confirmed via the Apify run console: clicking
// "Process" on a batch after adding one new card re-ran EVERY other
// already-processed card in that batch too, each burning a fresh paid Apify
// sold-comp lookup — because processBatch() reprocessed the whole batch
// unconditionally, and OCR/vision is non-deterministic enough between runs
// that an already-good card's re-derived apifyLookupKey rarely matches its
// cached one even when nothing needed to change.

test("needsBatchProcessing skips cards already priced, ready, listed, sold, or sent to grading", () => {
  for (const status of ["priced", "ready", "listed", "sold", "sent_to_grading"]) {
    assert.equal(needsBatchProcessing({ status }), false, `expected ${status} to be skipped`);
  }
});

test("needsBatchProcessing still reprocesses new/pending/needs_review cards", () => {
  for (const status of ["new", "ocr_pending", "needs_review"]) {
    assert.equal(needsBatchProcessing({ status }), true, `expected ${status} to be reprocessed`);
  }
});

test("needsBatchProcessing treats a card with no status at all as needing processing", () => {
  assert.equal(needsBatchProcessing({}), true);
});

// --- inferMetadataFromTitle (now exported for the untracked-listing import) -
// Confirms the export works and the underlying parse still returns the
// shape the import route depends on for a well-formed eBay title.

test("inferMetadataFromTitle parses player/year/set/number/parallel from a real eBay title", () => {
  const metadata = inferMetadataFromTitle(
    "2023 Panini Prizm Victor Wembanyama Silver Prizm #292 RC",
  );
  assert.equal(metadata.playerName, "Victor Wembanyama");
  assert.equal(metadata.year, 2023);
  assert.equal(metadata.setName, "Panini Prizm");
  assert.equal(metadata.cardNumber, "292");
  assert.equal(metadata.parallel, "Silver Prizm");
  assert.equal(metadata.rookieFlag, true);
  assert.equal(metadata.autographFlag, false);
});

test("inferMetadataFromTitle returns null when no player/year can be found", () => {
  assert.equal(inferMetadataFromTitle("Lot of 10 mixed sports cards - great starter lot"), null);
});

test("inferMetadataFromTitle respects custom provider/notesPrefix", () => {
  const metadata = inferMetadataFromTitle(
    "2023 Panini Prizm Victor Wembanyama Silver Prizm #292 RC",
    { provider: "ebay_untracked_import", notesPrefix: "Untracked eBay listing" },
  );
  assert.equal(metadata.provider, "ebay_untracked_import");
  assert.match(metadata.notes, /^Untracked eBay listing: /);
});

// --- describeBatchProcessingState -------------------------------------------
// A batch stuck at "processing" from a crashed/killed run (see the 24
// pre-existing stuck batches this feature was built for) looks identical to
// a live in-flight run unless something checks whether this process is
// actually still working on it.

test("describeBatchProcessingState flags a 'processing' batch as stuck when nothing is actively running it", () => {
  const result = describeBatchProcessingState({ status: "processing" }, [], false);
  assert.equal(result.stuck, true);
  assert.match(result.reason, /restart or crash/);
});

test("describeBatchProcessingState does not flag a 'processing' batch this process is actively running", () => {
  const result = describeBatchProcessingState({ status: "processing" }, [], true);
  assert.equal(result.stuck, false);
  assert.equal(result.reason, null);
});

test("describeBatchProcessingState does not flag batches in any other status", () => {
  for (const status of ["uploaded", "needs_review", "ready_to_publish", "published"]) {
    const result = describeBatchProcessingState({ status }, [], false);
    assert.equal(result.stuck, false, `expected ${status} not to be flagged stuck`);
  }
});

test("describeBatchProcessingState summarizes a per-status card breakdown", () => {
  const cards = [
    { status: "priced" },
    { status: "priced" },
    { status: "needs_review" },
    {},
  ];
  const result = describeBatchProcessingState({ status: "processing" }, cards, false);
  assert.deepEqual(result.cardBreakdown, { priced: 2, needs_review: 1, unknown: 1 });
});
