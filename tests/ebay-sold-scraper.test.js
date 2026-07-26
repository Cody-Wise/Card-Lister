import test from "node:test";
import assert from "node:assert/strict";
import {
  parseEbayPriceText,
  parseEbayShippingText,
  parseEbaySoldDateText,
  parseEbayItemIdFromUrl,
  toApifyShapedRow,
} from "../src/services/ebay-sold-scraper.js";
import { parseApifySoldListings } from "../src/services/apify.js";

// Text forms observed on real ebay.com/sch sold-search result pages
// (LH_Sold=1&LH_Complete=1) — the scraper's parsers must handle each
// variant and return null (never throw) on anything unrecognized.

test("parseEbayPriceText handles plain, thousands, and range prices", () => {
  assert.equal(parseEbayPriceText("$2.89"), 2.89);
  assert.equal(parseEbayPriceText("$1,234.56"), 1234.56);
  // A range means a multi-variation listing — low bound is the
  // conservative comp read.
  assert.equal(parseEbayPriceText("$2.89 to $5.00"), 2.89);
  assert.equal(parseEbayPriceText("2 bids"), null);
  assert.equal(parseEbayPriceText(""), null);
  assert.equal(parseEbayPriceText(null), null);
});

test("parseEbayShippingText maps free to 0, paid to the amount, unknown to null", () => {
  assert.equal(parseEbayShippingText("Free shipping"), 0);
  assert.equal(parseEbayShippingText("Free delivery"), 0);
  assert.equal(parseEbayShippingText("+$4.99 delivery"), 4.99);
  assert.equal(parseEbayShippingText("+ $17.32 shipping"), 17.32);
  assert.equal(parseEbayShippingText("Shipping not specified"), null);
  assert.equal(parseEbayShippingText(""), null);
});

test("parseEbaySoldDateText parses the 'Sold  Oct 12, 2025' caption into ISO", () => {
  assert.equal(parseEbaySoldDateText("Sold Oct 12, 2025"), "2025-10-12T00:00:00.000Z");
  // Doubled whitespace and full month names both occur.
  assert.equal(parseEbaySoldDateText("Sold  May 29, 2026"), "2026-05-29T00:00:00.000Z");
  assert.equal(parseEbaySoldDateText("Sold December 1, 2025"), "2025-12-01T00:00:00.000Z");
  assert.equal(parseEbaySoldDateText("Ended yesterday"), null);
  assert.equal(parseEbaySoldDateText(""), null);
});

test("parseEbayItemIdFromUrl extracts the numeric item id", () => {
  assert.equal(parseEbayItemIdFromUrl("https://www.ebay.com/itm/376661333183?nordt=true"), "376661333183");
  assert.equal(parseEbayItemIdFromUrl("/itm/327160280128"), "327160280128");
  assert.equal(parseEbayItemIdFromUrl("https://www.ebay.com/sch/i.html?_nkw=x"), null);
});

test("toApifyShapedRow maps a real scraped row onto the Apify actor's item shape", () => {
  const row = toApifyShapedRow(
    {
      title: "2023-24 Panini Phoenix Basketball Dereck Lively II #290 RC Mavericks Rookie",
      priceText: "$2.89",
      shippingText: "+$17.32 shipping",
      soldDateText: "Sold May 29, 2026",
      conditionText: "Pre-Owned",
      url: "https://www.ebay.com/itm/376661333183?hash=abc",
      bodyText: "2023-24 Panini Phoenix ... $2.89 ... Best offer accepted",
    },
    "2023 Dereck Lively II Phoenix 290",
  );
  assert.equal(row.title, "2023-24 Panini Phoenix Basketball Dereck Lively II #290 RC Mavericks Rookie");
  assert.equal(row.soldPrice, "2.89");
  assert.equal(row.shippingPrice, "17.32");
  assert.equal(row.totalPrice, "20.21");
  assert.equal(row.endedAt, "2026-05-29T00:00:00.000Z");
  assert.equal(row.itemId, "376661333183");
  assert.equal(row.url, "https://www.ebay.com/itm/376661333183");
  assert.equal(row.keyword, "2023 Dereck Lively II Phoenix 290");
  assert.equal(row.isBestOfferAccepted, true);
  assert.equal(row.listingType, "buy_it_now");
  assert.equal(row.condition, "Pre-Owned");
});

test("toApifyShapedRow drops placeholder and priceless rows", () => {
  assert.equal(toApifyShapedRow({ title: "Shop on eBay", priceText: "$20.00" }, "kw"), null);
  assert.equal(toApifyShapedRow({ title: "Real Card 2024", priceText: "" }, "kw"), null);
  assert.equal(toApifyShapedRow(null, "kw"), null);
});

test("scraper rows flow through parseApifySoldListings with identical gating to the Apify path", () => {
  // Same card, two rows: the right parallel and a wrong one. The parallel
  // gate in normalizeSoldListing is a HARD exclusion (the same one that
  // gates Apify-sourced rows), so exactly one row survives — proving
  // scraper rows get the identical quality bar, not a parallel pipeline.
  const metadata = {
    playerName: "Dereck Lively II",
    year: 2023,
    setName: "Phoenix Basketball",
    cardNumber: "290",
    parallel: "Teal Lazer",
  };
  const keyword = "2023 Dereck Lively II Phoenix Basketball 290 Teal Lazer";
  const rows = [
    toApifyShapedRow(
      {
        title: "2023-24 Panini Phoenix Dereck Lively II RC Teal Lazer Rookie #290 Mavericks",
        priceText: "$2.89",
        shippingText: "Free shipping",
        soldDateText: "Sold May 29, 2026",
        url: "https://www.ebay.com/itm/376661333183",
        bodyText: "",
      },
      keyword,
    ),
    toApifyShapedRow(
      {
        title: "2023-24 Panini Phoenix #290 Dereck Lively II Phoenix Green Lazer #/175",
        priceText: "$2.10",
        shippingText: "Free shipping",
        soldDateText: "Sold May 19, 2026",
        url: "https://www.ebay.com/itm/327160280128",
        bodyText: "",
      },
      keyword,
    ),
  ].filter(Boolean);
  const parsed = parseApifySoldListings(rows, metadata);
  assert.equal(parsed.comps.length, 1);
  assert.ok(parsed.comps[0].title.includes("Teal Lazer"));
  assert.equal(parsed.comps[0].source, "apify_sold_listings");
  assert.equal(parsed.rejectedCount, 1);
});
