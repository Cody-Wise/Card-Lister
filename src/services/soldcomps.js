// SoldComps (api.sold-comps.com) — a direct, documented eBay-sold-listings
// API, and the preferred per-card sold-comp provider.
//
// Why this rather than the Apify actor, given both reach the same data:
// SoldComps bills a FLAT MONTHLY REQUEST QUOTA, while the Apify actor bills
// per real run (observed $0.0001–$2+ each, and Market Heat alone once blew a
// $29/month cap in a few refreshes). Same underlying scrape, predictable cost.
//
// The two providers return the SAME item schema — itemId/title/condition/
// soldPrice/shippingPrice/totalPrice/endedAt/url/sellerUsername/
// sellerPositivePercent/sellerFeedbackScore — which is why everything
// downstream is shared, not duplicated: keyword building, item parsing,
// relevance filtering, dedupe and pricing are all imported from apify.js
// rather than reimplemented. Only the HTTP call, its config and the budget
// accounting differ.
//
// History: this integration existed before, was removed on 2026-07-03 in
// favour of the Apify actor (SoldComps' match quality had degraded), and is
// restored here at the user's direction on 2026-07-30. Recovered from
// c13a71a^ rather than rewritten, so the retry semantics and budget guard
// below are the originals, which were tuned against real production
// behaviour.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildApifyKeywords,
  parseApifySoldListings,
  dedupeListings,
  isTradingCardMetadata,
  resolveApifySoldCount,
  clampPositiveInt,
} from "./apify.js";

const SOLD_COMPS_BASE_URL = process.env.SOLDCOMPS_BASE_URL || "https://api.sold-comps.com";
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Any tuning knob left blank falls back to the corresponding APIFY_EBAY_*
// value, so the two providers stay configured consistently.
export function getSoldCompsConfig() {
  return {
    apiKey: process.env.SOLDCOMPS_API_KEY || "",
    daysToScrape: clampPositiveInt(
      Number(process.env.SOLDCOMPS_DAYS_TO_SCRAPE || process.env.APIFY_EBAY_SOLD_DAYS_TO_SCRAPE || 60),
      1,
      365,
    ),
    ebaySite: process.env.SOLDCOMPS_EBAY_SITE || process.env.APIFY_EBAY_SITE || "ebay.com",
    sortOrder: process.env.SOLDCOMPS_SORT_ORDER || process.env.APIFY_EBAY_SORT_ORDER || "endedRecently",
    itemLocation: process.env.SOLDCOMPS_ITEM_LOCATION || process.env.APIFY_EBAY_ITEM_LOCATION || "default",
    categoryId: process.env.SOLDCOMPS_CATEGORY_ID || "0",
  };
}

export function hasSoldCompsApiConfig() {
  return Boolean(getSoldCompsConfig().apiKey);
}

// The app does not know which SoldComps plan is active, so it tracks its own
// conservative monthly budget locally and fails with a clear message rather
// than hitting the provider's quota and then getting 403s on every lookup for
// the rest of the billing cycle.
// SOLDCOMPS_USAGE_FILE lets tests point this at an isolated temp file: Node's
// test runner runs separate *.test.js files concurrently, and this is real
// shared local state.
function soldCompsUsagePath() {
  return process.env.SOLDCOMPS_USAGE_FILE || path.join(rootDir, "data", "soldcomps-usage.json");
}

function currentUsageMonth() {
  return new Date().toISOString().slice(0, 7); // "YYYY-MM"
}

// Worst-case requests for ONE card lookup = keywords x attempts. That is
// cheap on a large plan and expensive on the 100/month free tier, where the
// default 2 keywords x 3 attempts would be 6% of the month for a single card.
// Configurable so the retry budget can be tuned to the plan.
export function soldCompsMaxAttempts() {
  const parsed = Number.parseInt(process.env.SOLDCOMPS_MAX_ATTEMPTS || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 5) : 3;
}

export function soldCompsMonthlyLimit() {
  const parsed = Number(process.env.SOLDCOMPS_MONTHLY_REQUEST_LIMIT);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90;
}

async function loadSoldCompsUsage() {
  try {
    const raw = await fs.readFile(soldCompsUsagePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.month === currentUsageMonth()) {
      return { month: parsed.month, count: Number(parsed.count) || 0 };
    }
  } catch {
    // No usage file yet, or unreadable — start a fresh month.
  }
  return { month: currentUsageMonth(), count: 0 };
}

async function saveSoldCompsUsage(usage) {
  await fs.mkdir(path.dirname(soldCompsUsagePath()), { recursive: true });
  await fs.writeFile(soldCompsUsagePath(), JSON.stringify(usage, null, 2));
}

async function hasSoldCompsBudget() {
  const usage = await loadSoldCompsUsage();
  return usage.count < soldCompsMonthlyLimit();
}

async function recordSoldCompsRequest() {
  const usage = await loadSoldCompsUsage();
  usage.count += 1;
  await saveSoldCompsUsage(usage);
  return usage;
}

export async function getSoldCompsUsageStatus() {
  const usage = await loadSoldCompsUsage();
  const limit = soldCompsMonthlyLimit();
  return {
    configured: hasSoldCompsApiConfig(),
    month: usage.month,
    count: usage.count,
    limit,
    remaining: Math.max(0, limit - usage.count),
    hasBudget: usage.count < limit,
  };
}

export async function searchSoldCompsListings(metadata = {}) {
  const config = getSoldCompsConfig();
  const requestedCount = resolveApifySoldCount(metadata);

  if (!config.apiKey) throw new Error("Missing SOLDCOMPS_API_KEY");

  if (!(await hasSoldCompsBudget())) {
    const limit = soldCompsMonthlyLimit();
    throw new Error(
      `SoldComps monthly request budget (${limit}) reached for this billing cycle — raise SOLDCOMPS_MONTHLY_REQUEST_LIMIT if you're on a higher-quota plan.`,
    );
  }

  const keywords = buildApifyKeywords(metadata);
  if (!keywords.length) {
    return {
      source: "soldcomps",
      comps: [],
      importedCount: 0,
      rejectedCount: 0,
      sampleTitles: [],
      keywordsUsed: [],
    };
  }

  const parsedRuns = [];
  const queryLimit = Math.min(
    keywords.length,
    metadata.baseHint || metadata.parallel || metadata.autographFlag ? 2 : 1,
  );
  const keywordsUsed = keywords.slice(0, queryLimit);

  for (const keyword of keywordsUsed) {
    const params = new URLSearchParams({
      keyword,
      daysToScrape: String(config.daysToScrape),
      count: String(requestedCount),
      ebaySite: config.ebaySite,
      sortOrder: config.sortOrder,
      itemLocation: config.itemLocation,
      itemCondition: isTradingCardMetadata(metadata) || metadata.gradedFlag ? "any" : "used",
      categoryId: config.categoryId,
    });

    // SoldComps is a live scrape, not a stable index — the same keyword
    // genuinely returns 0 items on a real fraction of calls (a production card
    // was observed alternating between 0 and 9 items across otherwise-identical
    // back-to-back requests), which surfaced as "comps not coming through"
    // whenever a reprocess happened to hit an empty draw. Retry only when the
    // SCRAPE came back empty: a non-empty scrape that our own relevance filter
    // later rejects is a real "no match", not flakiness.
    let items = [];
    const maxAttempts = soldCompsMaxAttempts();
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Budget is confirmed once up front, but a retry is still a real billed
      // request — re-check before each, or one call could burn through the
      // whole monthly cap in a single shot.
      if (attempt > 1 && !(await hasSoldCompsBudget())) break;
      const response = await fetch(`${SOLD_COMPS_BASE_URL}/v1/scrape?${params.toString()}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          payload?.error?.message || payload?.message || payload?.error || `HTTP ${response.status}`;
        throw new Error(`SoldComps sold listings request failed (${response.status}): ${message}`);
      }
      // Counted against the monthly budget only once the request succeeded.
      await recordSoldCompsRequest();

      items = Array.isArray(payload?.items) ? payload.items : [];
      if (items.length || attempt === maxAttempts) break;
      await sleep(500);
    }

    const queryParallel = keyword.includes("Blue Refractor")
      ? "Blue Refractor"
      : keyword.includes("Holo")
        ? "Holo"
        : keyword.includes("Blue")
          ? "Blue"
          : keyword.includes("Silver Prizm")
            ? "Silver Prizm"
            : null;
    parsedRuns.push(
      parseApifySoldListings(items, {
        ...metadata,
        baseHint: metadata.baseHint,
        parallel: queryParallel,
      }),
    );
  }

  const comps = dedupeListings(parsedRuns.flatMap((entry) => entry.comps)).sort(
    (a, b) => b.matchScore - a.matchScore || a.totalPrice - b.totalPrice,
  );
  const rejectedCount = parsedRuns.reduce((sum, entry) => sum + (entry.rejectedCount || 0), 0);
  return {
    source: "soldcomps",
    comps: comps.slice(0, requestedCount),
    importedCount: Math.min(comps.length, requestedCount),
    rejectedCount,
    sampleTitles: comps.slice(0, 5).map((comp) => comp.title),
    keywordsUsed,
  };
}
