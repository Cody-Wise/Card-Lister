import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePriceText,
  resolveDaCardWorldUrl,
  normalizeListing,
  dedupeListings,
  classifyDaCardWorldSport,
} from "../src/services/dacardworld.js";

test("parsePriceText parses a plain dollar amount", () => {
  assert.equal(parsePriceText("$4,999.95"), 4999.95);
});

test("parsePriceText parses a small amount with no thousands separator", () => {
  assert.equal(parsePriceText("$1.69"), 1.69);
});

test("parsePriceText returns null for unparsable or empty text", () => {
  assert.equal(parsePriceText(""), null);
  assert.equal(parsePriceText(null), null);
  assert.equal(parsePriceText("Sold Out"), null);
});

test("resolveDaCardWorldUrl resolves a relative href against the site root", () => {
  assert.equal(
    resolveDaCardWorldUrl("/sports-cards/2026-bowman-baseball-delight-6-box-case"),
    "https://www.dacardworld.com/sports-cards/2026-bowman-baseball-delight-6-box-case",
  );
});

test("resolveDaCardWorldUrl leaves an already-absolute URL untouched", () => {
  assert.equal(
    resolveDaCardWorldUrl("https://www.dacardworld.com/sports-cards/foo"),
    "https://www.dacardworld.com/sports-cards/foo",
  );
});

test("resolveDaCardWorldUrl returns null for an empty href", () => {
  assert.equal(resolveDaCardWorldUrl(""), null);
  assert.equal(resolveDaCardWorldUrl(null), null);
});

test("normalizeListing builds a full entry from a real classic-grid-shaped raw row", () => {
  const result = normalizeListing({
    title: "2026 Bowman Baseball Delight 6-Box Case",
    href: "/sports-cards/2026-bowman-baseball-delight-6-box-case",
    priceText: "$4,999.95",
    discountPriceText: "",
    isNew: true,
  });
  assert.deepEqual(result, {
    title: "2026 Bowman Baseball Delight 6-Box Case",
    url: "https://www.dacardworld.com/sports-cards/2026-bowman-baseball-delight-6-box-case",
    price: 4999.95,
    originalPrice: null,
    isNew: true,
    sport: "Baseball",
  });
});

test("normalizeListing keeps originalPrice only when it's genuinely higher than the current price", () => {
  const result = normalizeListing({
    title: "Discounted Box",
    href: "/sports-cards/discounted-box",
    priceText: "$149.95",
    discountPriceText: "$179.95",
    isNew: false,
  });
  assert.equal(result.price, 149.95);
  assert.equal(result.originalPrice, 179.95);
});

test("normalizeListing drops originalPrice when the 'discount' price isn't actually higher", () => {
  const result = normalizeListing({
    title: "Weird Data",
    href: "/sports-cards/weird",
    priceText: "$50.00",
    discountPriceText: "$40.00",
    isNew: false,
  });
  assert.equal(result.originalPrice, null);
});

test("normalizeListing returns null for a row with no usable title", () => {
  assert.equal(normalizeListing({ title: "", href: "/sports-cards/foo" }), null);
});

test("normalizeListing returns null for a row with no resolvable URL", () => {
  assert.equal(normalizeListing({ title: "No Link Item", href: "" }), null);
});

test("classifyDaCardWorldSport matches real production titles correctly", () => {
  assert.equal(classifyDaCardWorldSport("2025/26 Upper Deck SP Authentic Hockey Hobby Box"), "Hockey");
  assert.equal(classifyDaCardWorldSport("2026 Panini Select NASCAR Racing Hobby Box"), "Racing");
  assert.equal(
    classifyDaCardWorldSport("2026 Club Legacyz Icons World Heroes Soccer Fourth Edition Hobby Box"),
    "Soccer",
  );
  assert.equal(classifyDaCardWorldSport("2026 Leaf Baseball Nation Hobby Jumbo"), "Baseball");
  assert.equal(classifyDaCardWorldSport("2026 Topps Series 1 Baseball Hanger Box"), "Baseball");
});

test("classifyDaCardWorldSport falls back to Other for an unrecognized title", () => {
  assert.equal(classifyDaCardWorldSport("2026 Mystery Trading Card Box"), "Other");
  assert.equal(classifyDaCardWorldSport(""), "Other");
});

test("classifyDaCardWorldSport recognizes TCG/non-sport product", () => {
  assert.equal(classifyDaCardWorldSport("Pokemon Scarlet & Violet Booster Box"), "TCG/Non-Sport");
  assert.equal(classifyDaCardWorldSport("Magic: The Gathering Foundations Collector Booster"), "TCG/Non-Sport");
});

test("dedupeListings keeps the first occurrence of each URL", () => {
  const items = [
    { title: "A", url: "https://www.dacardworld.com/a", price: 10, originalPrice: null, isNew: true },
    { title: "A dup", url: "https://www.dacardworld.com/a", price: 12, originalPrice: null, isNew: false },
    { title: "B", url: "https://www.dacardworld.com/b", price: 5, originalPrice: null, isNew: false },
  ];
  const result = dedupeListings(items);
  assert.equal(result.length, 2);
  assert.equal(result[0].title, "A");
  assert.equal(result[1].title, "B");
});

test("dedupeListings skips null/undefined entries safely", () => {
  const items = [
    null,
    { title: "A", url: "https://www.dacardworld.com/a", price: 10, originalPrice: null, isNew: true },
    undefined,
  ];
  const result = dedupeListings(items);
  assert.equal(result.length, 1);
});
