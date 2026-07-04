import test from "node:test";
import assert from "node:assert/strict";
import { isRelevantComp } from "../src/jobs/pipeline.js";

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
