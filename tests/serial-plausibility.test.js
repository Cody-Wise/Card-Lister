import test from "node:test";
import assert from "node:assert/strict";

import {
  isPlausibleSerial,
  looksLikeSetNumbering,
  parsePrintRunFromSerial,
} from "../src/lib/card-query.js";

// Every case below came out of production state on 2026-07-30, where 14 of 42
// stored serials were mathematically impossible and cards with no serial at
// all were being shown as serial-numbered.

test("a serial index can never exceed its print run", () => {
  assert.equal(isPlausibleSerial(58, 75), true);
  assert.equal(isPlausibleSerial(1, 1), true, "a genuine 1-of-1");
  assert.equal(isPlausibleSerial(75, 75), true, "the last card of the run");

  // Real impossible values found stored on cards:
  assert.equal(isPlausibleSerial(611, 75), false);
  assert.equal(isPlausibleSerial(3, 1), false, "\"3/01\" from a scan filename");
  assert.equal(isPlausibleSerial(7, 1), false, "\"7/01\" — price + front/back index");
});

test("a zero-padded run is a file index, not a one-of-one", () => {
  // "1/01" passed the magnitude check (1 <= 1) and stored a base Stephen Curry
  // and a base Martinez as 1-of-1s. Real numbering is never zero-padded.
  assert.equal(isPlausibleSerial("1", "01"), false);
  assert.equal(isPlausibleSerial("1", "02"), false);
  assert.equal(isPlausibleSerial("1", "1"), true, "a genuine 1-of-1 still passes");
  assert.equal(isPlausibleSerial(1, 1), true, "numeric form unaffected");
  assert.equal(isPlausibleSerial("02", "25"), true, "a padded INDEX is normal (02/25)");
});

test("zero, negative and absurd runs are rejected", () => {
  assert.equal(isPlausibleSerial(0, 25), false);
  assert.equal(isPlausibleSerial(5, 0), false);
  assert.equal(isPlausibleSerial(-1, 25), false);
  assert.equal(isPlausibleSerial(1, 999999), false, "a barcode or price, not a run");
  assert.equal(isPlausibleSerial("abc", 25), false);
  assert.equal(isPlausibleSerial(null, undefined), false);
});

test("set numbering is not serial numbering", () => {
  // "1970 Super Stars Dick Butkus No. 10 of 60" is card 10 of a 60-card SET.
  const text = "3-D SUPER STARS 1970 Dick Butkus No. 10 of 60";
  const match = /\b(\d{1,4})\s*(?:of|out of)\s*(\d{1,5})\b/i.exec(text);
  assert.ok(match);
  assert.equal(looksLikeSetNumbering(text, match.index), true);

  // A bare "10 of 60" with no "No."/"Card" in front is a real serial.
  const plain = "Panini Select Blue Prizm 10 of 60";
  const plainMatch = /\b(\d{1,4})\s*(?:of|out of)\s*(\d{1,5})\b/i.exec(plain);
  assert.equal(looksLikeSetNumbering(plain, plainMatch.index), false);
});

test("parsePrintRunFromSerial applies the same guards", () => {
  assert.equal(parsePrintRunFromSerial("58/75"), 75);
  assert.equal(parsePrintRunFromSerial("1/1"), 1);
  assert.equal(parsePrintRunFromSerial("10 of 60"), 60);

  assert.equal(parsePrintRunFromSerial("611/75"), null, "index above the run");
  assert.equal(parsePrintRunFromSerial("7/01"), null, "price + file index");
  assert.equal(parsePrintRunFromSerial("No. 10 of 60"), null, "set numbering");
  assert.equal(parsePrintRunFromSerial(""), null);
  assert.equal(parsePrintRunFromSerial(null), null);
});
