import test from "node:test";
import assert from "node:assert/strict";
import { parsePriceFromFileName, resolveManualPriceFromFileNames } from "../src/lib/filename-price.js";

// Real workflow: cards are scanned with eBay's card scanner and the scanner
// types their judged price into the filename — "LebronJames$7-01.jpg".

test("parses the price from the real filename shape", () => {
  assert.equal(parsePriceFromFileName("LebronJames$7-01.jpg"), 7);
  assert.equal(parsePriceFromFileName("LebronJames$7-02.jpg"), 7);
});

test("the trailing scan sequence is never mistaken for the price", () => {
  // "-01" / "-02" are scan indexes. If these leaked through as prices the
  // whole feature would silently produce $1 and $2 cards.
  assert.equal(parsePriceFromFileName("Card$25-01.jpg"), 25);
  assert.equal(parsePriceFromFileName("Card$25-02.jpg"), 25);
  assert.equal(parsePriceFromFileName("Card-01.jpg"), null);
  assert.equal(parsePriceFromFileName("Card-02.jpg"), null);
});

test("handles decimals, thousands separators, and larger amounts", () => {
  assert.equal(parsePriceFromFileName("Card$12.50-01.jpg"), 12.5);
  assert.equal(parsePriceFromFileName("Card$1,200-01.jpg"), 1200);
  assert.equal(parsePriceFromFileName("Card$1200.99-01.jpg"), 1200.99);
  assert.equal(parsePriceFromFileName("Jordan$450-01.png"), 450);
});

test("tolerates a space after the dollar sign", () => {
  assert.equal(parsePriceFromFileName("Card$ 15-01.jpg"), 15);
});

test("requires an explicit $ — bare numbers are too ambiguous to trust", () => {
  // Card numbers, years, and serials all look like bare numbers; guessing
  // would produce confidently wrong manual anchors.
  assert.equal(parsePriceFromFileName("LebronJames7-01.jpg"), null);
  assert.equal(parsePriceFromFileName("2023-Prizm-290-01.jpg"), null);
  assert.equal(parsePriceFromFileName("Card 25 of 99-01.jpg"), null);
});

test("the file extension's dot is never read as a decimal point", () => {
  assert.equal(parsePriceFromFileName("Card$5.jpg"), 5);
  assert.equal(parsePriceFromFileName("Card$5.jpeg"), 5);
  assert.equal(parsePriceFromFileName("Card$5.png"), 5);
});

test("rejects zero, negatives, and implausible amounts", () => {
  assert.equal(parsePriceFromFileName("Card$0-01.jpg"), null);
  assert.equal(parsePriceFromFileName("Card$0.00-01.jpg"), null);
  assert.equal(parsePriceFromFileName("Card$999999999-01.jpg"), null);
});

test("handles empty and malformed input without throwing", () => {
  assert.equal(parsePriceFromFileName(""), null);
  assert.equal(parsePriceFromFileName(null), null);
  assert.equal(parsePriceFromFileName(undefined), null);
  assert.equal(parsePriceFromFileName("$"), null);
  // A "$" with no digits immediately after isn't a price — the "-01" that
  // follows is the scan sequence, and reading it as $1 would be worse than
  // returning nothing.
  assert.equal(parsePriceFromFileName("Card$-01.jpg"), null);
});

test("resolveManualPriceFromFileNames prefers the front scan", () => {
  const result = resolveManualPriceFromFileNames("Lebron$7-01.jpg", "Lebron$7-02.jpg");
  assert.equal(result.price, 7);
  assert.equal(result.source, "front");
  assert.equal(result.conflict, null);
});

test("falls back to the back scan when only it carries a price", () => {
  const result = resolveManualPriceFromFileNames("Lebron-01.jpg", "Lebron$7-02.jpg");
  assert.equal(result.price, 7);
  assert.equal(result.source, "back");
});

test("a front/back price disagreement is surfaced, not silently resolved", () => {
  // Someone mistyped. Quietly trusting one number would defeat the point of
  // a human price check.
  const result = resolveManualPriceFromFileNames("Lebron$7-01.jpg", "Lebron$70-02.jpg");
  assert.equal(result.price, 7, "front still wins so processing can continue");
  assert.deepEqual(result.conflict, { front: 7, back: 70 });
  assert.match(result.note, /conflict/i);
});

test("no price anywhere yields a clean null result", () => {
  const result = resolveManualPriceFromFileNames("Lebron-01.jpg", "Lebron-02.jpg");
  assert.equal(result.price, null);
  assert.equal(result.source, null);
  assert.equal(result.conflict, null);
});
