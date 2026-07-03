import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { calculatePrice } from "../src/services/pricing.js";
import { parseApifySoldListings, searchApifySoldListings } from "../src/services/apify.js";
import { searchEbayListings } from "../src/services/ebay-browse.js";

// Several tests below call searchApifySoldListings() with a real (mocked)
// SOLDCOMPS_API_KEY set, which would otherwise increment the real local
// monthly usage counter at data/soldcomps-usage.json. Point it at an
// isolated per-file temp path instead — Node's test runner runs separate
// *.test.js files concurrently by default, so sharing the real file with
// other suites (e.g. soldcomps-budget.test.js) would race.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.SOLDCOMPS_USAGE_FILE = path.join(rootDir, "tmp", "test-soldcomps-usage-apify.json");

test("searchApifySoldListings calls SoldComps at the documented endpoint with a Bearer auth header", async (t) => {
  const originalFetch = global.fetch;
  const originalKey = process.env.SOLDCOMPS_API_KEY;
  process.env.SOLDCOMPS_API_KEY = "sc_test_key_123";

  t.after(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) {
      delete process.env.SOLDCOMPS_API_KEY;
    } else {
      process.env.SOLDCOMPS_API_KEY = originalKey;
    }
  });

  let requestedUrl = null;
  let requestedInit = null;
  global.fetch = async (url, init) => {
    requestedUrl = url;
    requestedInit = init;
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };

  await searchApifySoldListings({ playerName: "Test Player", year: 2024, setName: "Test Set", cardNumber: "1" });

  const parsed = new URL(requestedUrl);
  assert.equal(`${parsed.protocol}//${parsed.host}`, "https://api.sold-comps.com");
  assert.equal(parsed.pathname, "/v1/scrape");
  assert.ok(parsed.searchParams.get("keyword"));
  assert.equal(requestedInit.method, "GET");
  assert.equal(requestedInit.headers.Authorization, "Bearer sc_test_key_123");
});

test("parses apify sold listings and filters noisy lots", () => {
  const result = parseApifySoldListings(
    [
      {
        keyword: "jalen brunson 2018 rated rookie",
        itemId: "168438877206",
        title: "JALEN BRUNSON 2018-19 OPTIC SILVER HOLO RATED ROOKIE RC #179 KNICKS MINT",
        condition: "Pre-Owned",
        soldPrice: "79.99",
        shippingPrice: "8.15",
        totalPrice: "88.14",
        endedAt: "2026-06-07T00:00:00.000Z",
        url: "https://www.ebay.com/itm/168438877206?nordt=true",
        listingType: "buy_it_now",
      },
      {
        keyword: "jalen brunson 2018 rated rookie",
        itemId: "398011773510",
        title: "Panini Donruss 3-Card Rookie Lot Towns The Rookies #21 Brunson #179",
        condition: "Pre-Owned",
        soldPrice: "25.00",
        shippingPrice: "6.95",
        totalPrice: "31.95",
        endedAt: "2026-06-07T00:00:00.000Z",
        url: "https://www.ebay.com/itm/398011773510?nordt=true",
        listingType: "auction",
      },
    ],
    {
      playerName: "Jalen Brunson",
      year: 2018,
      setName: "Panini Donruss Optic Basketball",
      cardNumber: "179",
      rookieFlag: true,
      variantLabel: "Rated Rookie",
    },
  );

  assert.equal(result.importedCount, 1);
  assert.equal(result.rejectedCount, 1);
  assert.equal(result.comps[0].title.toLowerCase().includes("rated rookie"), true);
  assert.equal(result.comps[0].totalPrice, 88.14);
});

test("keeps only base comps when base hint is set", () => {
  const result = parseApifySoldListings(
    [
      {
        keyword: "2024 Caitlin Clark Panini Prizm Draft Picks 57 Base",
        itemId: "base_1",
        title: "2024 Panini Prizm Draft Picks Caitlin Clark #57 Base",
        condition: "Pre-Owned",
        soldPrice: "6.99",
        shippingPrice: "0.00",
        totalPrice: "6.99",
        endedAt: "2026-06-07T00:00:00.000Z",
        url: "https://www.ebay.com/itm/base_1?nordt=true",
        listingType: "buy_it_now",
      },
      {
        keyword: "2024 Caitlin Clark Panini Prizm Draft Picks 57 Base",
        itemId: "var_1",
        title: "2024 Panini Prizm Draft Picks Caitlin Clark #57 Blue Shimmer /99",
        condition: "Pre-Owned",
        soldPrice: "24.99",
        shippingPrice: "0.00",
        totalPrice: "24.99",
        endedAt: "2026-06-07T00:00:00.000Z",
        url: "https://www.ebay.com/itm/var_1?nordt=true",
        listingType: "buy_it_now",
      },
    ],
    {
      playerName: "Caitlin Clark",
      year: 2024,
      setName: "Panini Prizm Draft Picks",
      cardNumber: "57",
      baseHint: true,
    },
  );

  assert.equal(result.importedCount, 1);
  assert.equal(result.rejectedCount, 1);
  assert.ok(result.comps[0].title.includes("Base"));
});

test("searches base cards without pulling a parallel lane", async (t) => {
  const originalFetch = global.fetch;
  const originalToken = process.env.SOLDCOMPS_API_KEY;
  process.env.SOLDCOMPS_API_KEY = "test-key";

  t.after(() => {
    global.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.SOLDCOMPS_API_KEY;
    } else {
      process.env.SOLDCOMPS_API_KEY = originalToken;
    }
  });

  let callCount = 0;
  global.fetch = async (_url, options) => {
    callCount += 1;
    const keyword = new URL(_url).searchParams.get("keyword") || "";
    const rows = [
      {
        keyword,
        itemId: "caitlin_base_1",
        title: "2024 Panini Prizm Draft Picks Caitlin Clark #57 Base",
        condition: "Pre-Owned",
        soldPrice: "6.99",
        shippingPrice: "0.00",
        totalPrice: "6.99",
        endedAt: "2026-06-07T00:00:00.000Z",
        url: "https://www.ebay.com/itm/caitlin_base_1?nordt=true",
        listingType: "buy_it_now",
      },
      {
        keyword,
        itemId: "caitlin_var_1",
        title: "2024 Panini Prizm Draft Picks Caitlin Clark #57 Blue Shimmer /99",
        condition: "Pre-Owned",
        soldPrice: "24.99",
        shippingPrice: "0.00",
        totalPrice: "24.99",
        endedAt: "2026-06-07T00:00:00.000Z",
        url: "https://www.ebay.com/itm/caitlin_var_1?nordt=true",
        listingType: "buy_it_now",
      },
    ];

    return {
      ok: true,
      status: 200,
      json: async () => ({ items: rows }),
    };
  };

  const result = await searchApifySoldListings({
    playerName: "Caitlin Clark",
    year: 2024,
    setName: "Panini Prizm Draft Picks",
    cardNumber: "57",
    baseHint: true,
  });

  assert.equal(callCount, 2);
  assert.ok(result.keywordsUsed.some((keyword) => keyword.includes("Base")));
  assert.ok(result.keywordsUsed.every((keyword) => !keyword.includes("Blue Shimmer")));
  assert.equal(result.comps.length, 1);
  assert.ok(result.comps[0].title.includes("Base"));
});

test("searches parallel-aware apify comps and prices Islam around four dollars", async (t) => {
  const originalFetch = global.fetch;
  const originalToken = process.env.SOLDCOMPS_API_KEY;
  process.env.SOLDCOMPS_API_KEY = "test-key";

  t.after(() => {
    global.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.SOLDCOMPS_API_KEY;
    } else {
      process.env.SOLDCOMPS_API_KEY = originalToken;
    }
  });

  let callCount = 0;
  let firstKeyword = null;
  global.fetch = async (_url, options) => {
    callCount += 1;
    const keyword = new URL(_url).searchParams.get("keyword") || "";
    if (!firstKeyword) firstKeyword = keyword;
    const rows =
      callCount === 1
        ? [
            {
              keyword,
              itemId: "ism_1",
              title: "2025 Topps Chrome UFC Islam Makhachev #TTC-19 Blue Refractor 002/150",
              condition: "Pre-Owned",
              soldPrice: "4.33",
              shippingPrice: "0.00",
              totalPrice: "4.33",
              endedAt: "2026-06-07T00:00:00.000Z",
              url: "https://www.ebay.com/itm/ism_1?nordt=true",
              listingType: "buy_it_now",
            },
            {
              keyword,
              itemId: "ism_2",
              title: "2025 Topps Chrome UFC Islam Makhachev #TTC-19 002/150",
              condition: "Pre-Owned",
              soldPrice: "4.25",
              shippingPrice: "0.00",
              totalPrice: "4.25",
              endedAt: "2026-06-06T00:00:00.000Z",
              url: "https://www.ebay.com/itm/ism_2?nordt=true",
              listingType: "buy_it_now",
            },
          ]
        : [
            {
              keyword,
              itemId: "ism_1",
              title: "2025 Topps Chrome UFC Islam Makhachev #TTC-19 Blue Refractor 002/150",
              condition: "Pre-Owned",
              soldPrice: "4.33",
              shippingPrice: "0.00",
              totalPrice: "4.33",
              endedAt: "2026-06-07T00:00:00.000Z",
              url: "https://www.ebay.com/itm/ism_1?nordt=true",
              listingType: "buy_it_now",
            },
            {
              keyword,
              itemId: "ism_3",
              title: "2025 Topps Chrome UFC Islam Makhachev #TTC-19 Blue Refractor",
              condition: "Pre-Owned",
              soldPrice: "4.75",
              shippingPrice: "0.00",
              totalPrice: "4.75",
              endedAt: "2026-06-05T00:00:00.000Z",
              url: "https://www.ebay.com/itm/ism_3?nordt=true",
              listingType: "buy_it_now",
            },
          ];

    return {
      ok: true,
      status: 200,
      json: async () => ({ items: rows }),
    };
  };

  const result = await searchApifySoldListings({
    playerName: "Islam Makhachev",
    year: 2025,
    setName: "Topps Chrome UFC",
    cardNumber: "TTC-19",
    parallel: "Blue Refractor",
    serialNumber: "002/150",
    printRun: 150,
    rookieFlag: false,
  });

  const pricing = calculatePrice({
    soldComps: result.comps,
    activeListings: [{ price: 4.99 }],
    strategy: "sold_comps_p25",
  });

  assert.equal(callCount, 2);
  assert.ok(firstKeyword.startsWith("2025"));
  assert.ok(firstKeyword.includes("Topps Chrome UFC"));
  assert.ok(result.keywordsUsed[0].startsWith("2025"));
  assert.ok(result.keywordsUsed[0].includes("Topps Chrome UFC"));
  assert.ok(!result.keywordsUsed[0].includes("002/150"));
  assert.ok(result.comps.length >= 2);
  assert.ok(result.comps.some((comp) => comp.title.includes("Blue Refractor")));
  assert.ok(pricing.recommendedPrice > 4);
  assert.ok(pricing.recommendedPrice < 5);
});

test("searches autographed serial-numbered cards with autograph hints and denominator serials", async (t) => {
  const originalFetch = global.fetch;
  const originalToken = process.env.SOLDCOMPS_API_KEY;
  process.env.SOLDCOMPS_API_KEY = "test-key";

  t.after(() => {
    global.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.SOLDCOMPS_API_KEY;
    } else {
      process.env.SOLDCOMPS_API_KEY = originalToken;
    }
  });

  let callCount = 0;
  let firstKeyword = null;
  global.fetch = async (_url, options) => {
    callCount += 1;
    const keyword = new URL(_url).searchParams.get("keyword") || "";
    if (!firstKeyword) firstKeyword = keyword;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            keyword,
            itemId: "auto_1",
            title: "2024 Panini Contenders Football Aurélien Tchouaméni Autograph 002/049",
            condition: "Pre-Owned",
            soldPrice: "12.49",
            shippingPrice: "0.00",
            totalPrice: "12.49",
            endedAt: "2026-06-07T00:00:00.000Z",
            url: "https://www.ebay.com/itm/auto_1?nordt=true",
            listingType: "buy_it_now",
          },
        ],
      }),
    };
  };

  const result = await searchApifySoldListings({
    playerName: "Aurélien Tchouaméni",
    year: 2024,
    setName: "Panini Contenders Football",
    cardNumber: "12",
    serialNumber: "002/049",
    printRun: 49,
    autographFlag: true,
  });

  assert.ok(callCount >= 1);
  assert.ok(firstKeyword.includes("/49"));
  assert.ok(!firstKeyword.includes("002/049"));
  assert.ok(firstKeyword.includes("Autograph"));
  assert.ok(result.keywordsUsed.some((keyword) => keyword.includes("Autograph")));
  assert.ok(result.keywordsUsed.some((keyword) => keyword.includes("Auto")));
  assert.equal(result.comps.length, 1);
  assert.ok(result.comps[0].title.includes("Autograph"));
});

test("searches autographed serial-numbered browse listings with autograph hints and denominator serials", async (t) => {
  const originalFetch = global.fetch;
  const originalClientId = process.env.EBAY_CLIENT_ID;
  const originalClientSecret = process.env.EBAY_CLIENT_SECRET;
  process.env.EBAY_CLIENT_ID = "client-id";
  process.env.EBAY_CLIENT_SECRET = "client-secret";

  t.after(() => {
    global.fetch = originalFetch;
    if (originalClientId === undefined) {
      delete process.env.EBAY_CLIENT_ID;
    } else {
      process.env.EBAY_CLIENT_ID = originalClientId;
    }
    if (originalClientSecret === undefined) {
      delete process.env.EBAY_CLIENT_SECRET;
    } else {
      process.env.EBAY_CLIENT_SECRET = originalClientSecret;
    }
  });

  const searchQueries = [];
  global.fetch = async (url, options = {}) => {
    const stringUrl = String(url);
    if (stringUrl.includes("/identity/v1/oauth2/token")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "app-token",
          expires_in: 7200,
        }),
      };
    }

    if (stringUrl.includes("/buy/browse/v1/item_summary/search")) {
      const parsedUrl = new URL(stringUrl);
      searchQueries.push(parsedUrl.searchParams.get("q") || "");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          itemSummaries: [],
        }),
      };
    }

    throw new Error(`Unexpected request ${options.method || "GET"} ${stringUrl}`);
  };

  await searchEbayListings({
    metadata: {
      playerName: "Aurélien Tchouaméni",
      year: 2024,
      setName: "Panini Contenders Football",
      cardNumber: "12",
      serialNumber: "002/049",
      printRun: 49,
      autographFlag: true,
    },
  });

  assert.ok(searchQueries.some((query) => query.includes("/49")));
  assert.ok(searchQueries.some((query) => query.includes("Autograph")));
  assert.ok(searchQueries.every((query) => !query.includes("002/049")));
});

test("searches generic rookie cards as rookie rc instead of rated rookie", async (t) => {
  const originalFetch = global.fetch;
  const originalToken = process.env.SOLDCOMPS_API_KEY;
  process.env.SOLDCOMPS_API_KEY = "test-key";

  t.after(() => {
    global.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.SOLDCOMPS_API_KEY;
    } else {
      process.env.SOLDCOMPS_API_KEY = originalToken;
    }
  });

  let callCount = 0;
  global.fetch = async (_url, options) => {
    callCount += 1;
    const keyword = new URL(_url).searchParams.get("keyword") || "";
    return {
      ok: true,
      status: 200,
      json: async () => ({
        items: keyword.includes("Rookie RC")
          ? [
              {
                keyword,
                itemId: "sga_1",
                title: "2018-19 Panini Chronicles Shai Gilgeous-Alexander #89 Rookie RC",
                condition: "Pre-Owned",
                soldPrice: "7.49",
                shippingPrice: "0.00",
                totalPrice: "7.49",
                endedAt: "2026-06-07T00:00:00.000Z",
                url: "https://www.ebay.com/itm/sga_1?nordt=true",
                listingType: "buy_it_now",
              },
              {
                keyword,
                itemId: "sga_2",
                title: "2018-19 Panini Optic Shai Gilgeous-Alexander Rated Rookie RC #89",
                condition: "Pre-Owned",
                soldPrice: "18.99",
                shippingPrice: "0.00",
                totalPrice: "18.99",
                endedAt: "2026-06-07T00:00:00.000Z",
                url: "https://www.ebay.com/itm/sga_2?nordt=true",
                listingType: "buy_it_now",
              },
            ]
          : [],
      }),
    };
  };

  const result = await searchApifySoldListings({
    playerName: "Shai Gilgeous-Alexander",
    year: 2018,
    setName: "2018-19 Panini Chronicles Basketball",
    cardNumber: "89",
    rookieFlag: true,
  });

  assert.equal(callCount, 1);
  assert.ok(result.keywordsUsed.some((keyword) => keyword.includes("Rookie RC")));
  assert.ok(result.keywordsUsed.every((keyword) => !keyword.includes("Rated Rookie")));
  assert.equal(result.comps.length, 1);
  assert.ok(result.comps[0].title.includes("Rookie RC"));
});
