// Scarcity-tiered pricing from ACTIVE eBay listings.
//
// Why this exists: as of 2026-07-26, eBay gates sold/completed listings
// behind sign-in. Confirmed by controlled test — same browser, same sticky
// residential IP, same cookie jar: a plain search returned 62 rows, and
// adding LH_Sold=1&LH_Complete=1 returned a sign-in wall. So sold comps
// are unavailable to us without authentication (and the Marketplace
// Insights API application is still pending). Active listings, by
// contrast, are served normally — they're the one eBay price signal fully
// open to us right now.
//
// The tradeoff, stated plainly: active listings are ASKS, not SALES. They
// answer "what will win the buy box" rather than "what does this fetch."
// They skew high (unsold inventory is unsold for a reason), so the default
// statistic here is a low percentile rather than the median, and callers
// are still expected to apply their own per-card floors.
//
// The tiering rule (user's spec): match on exact print run when possible;
// otherwise fall back to the nearest available print-run tier and adjust
// for the scarcity difference. A /25 compared against /50 listings should
// carry a premium; that same /25 compared against /10 listings should come
// in below them.
import { derivedPrintRun } from "../lib/card-query.js";

const DEFAULT_MAX_LISTINGS = 50;
// Card value scales sub-linearly with scarcity — a /25 is worth more than
// a /50 of the same card, but nowhere near double. An exponent around 0.4
// encodes that: halving the print run yields ~32% more, not 100% more.
// Tunable because different sports/eras behave differently.
const DEFAULT_SCARCITY_EXPONENT = 0.4;
// Hard bounds so a wild tier gap (a /1 priced off /500 listings) can't
// produce an absurd multiplier off a single thin comparison.
const DEFAULT_MIN_FACTOR = 0.5;
const DEFAULT_MAX_FACTOR = 2.0;

function envNumber(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function scarcityExponent() {
  const value = envNumber("ACTIVE_PRICING_SCARCITY_EXPONENT", DEFAULT_SCARCITY_EXPONENT);
  return value > 0 && value <= 1 ? value : DEFAULT_SCARCITY_EXPONENT;
}

// Pulls a print run off a listing. Prefers a structured field when the
// caller has one, else reads it out of the title ("#/175", "1/25",
// "25 of 99"). Returns null for unnumbered/base cards — which is a
// meaningful value here, not a failure.
export function printRunFromListing(listing = {}) {
  const structured = derivedPrintRun(listing);
  if (Number.isFinite(structured) && structured > 0) return structured;
  const title = String(listing.title || "");

  // Patterns are ordered most- to least-explicit. The serial form caps its
  // LEFT side at 3 digits on purpose: a 4-digit left side is a season
  // ("2023/24 Panini"), not a serial, and would otherwise be read as a
  // print run of 24.
  const patterns = [
    /#\s*\/\s*(\d{1,4})\b/, //            "#/175"
    /\b\d{1,3}\s*\/\s*(\d{1,4})\b/, //    "08/25", "12/99"
    /(?<![\d/])\/\s*(\d{1,4})\b/, //      bare "/25" — very common in real titles
    /\b\d{1,3}\s+(?:of|out of)\s+(\d{1,4})\b/i, // "10 of 60"
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(title);
    if (match) {
      const run = Number(match[1]);
      if (Number.isFinite(run) && run > 0) return run;
    }
  }
  return null;
}

// How much to adjust a comparable price when the comp tier's print run
// differs from the target's. <1 print run means rarer means dearer.
//   target /25 vs comp /50 -> (50/25)^0.4 = 1.32  (premium, as specified)
//   target /25 vs comp /10 -> (10/25)^0.4 = 0.69  (discount, as specified)
// Equal runs return exactly 1. An unnumbered comp tier (null) is treated
// as the most common tier there is, so a numbered target priced off
// unnumbered listings takes the max premium rather than a nonsense ratio.
export function scarcityFactor(targetPrintRun, compPrintRun, options = {}) {
  const exponent = Number.isFinite(options.exponent) ? options.exponent : scarcityExponent();
  const minFactor = Number.isFinite(options.minFactor)
    ? options.minFactor
    : envNumber("ACTIVE_PRICING_MIN_FACTOR", DEFAULT_MIN_FACTOR);
  const maxFactor = Number.isFinite(options.maxFactor)
    ? options.maxFactor
    : envNumber("ACTIVE_PRICING_MAX_FACTOR", DEFAULT_MAX_FACTOR);

  const target = Number.isFinite(targetPrintRun) && targetPrintRun > 0 ? targetPrintRun : null;
  const comp = Number.isFinite(compPrintRun) && compPrintRun > 0 ? compPrintRun : null;

  // Neither numbered, or identical: no adjustment.
  if (target === comp) return 1;
  // Target is numbered, comps aren't -> comps are the common version.
  if (target && !comp) return maxFactor;
  // Target is unnumbered but comps are numbered -> target is the common one.
  if (!target && comp) return minFactor;

  const raw = Math.pow(comp / target, exponent);
  return Math.min(maxFactor, Math.max(minFactor, raw));
}

// Groups candidate listings into print-run tiers and picks the one to
// price against: the exact tier when it has any listings, else whichever
// tier's print run is closest to the target on a ratio basis (a /50 is
// "closer" to a /25 than a /500 is, even though 25 and 475 differ by more
// in absolute terms).
export function selectCompTier(listings = [], targetPrintRun = null, options = {}) {
  const maxListings = Number.isFinite(options.maxListings) ? options.maxListings : DEFAULT_MAX_LISTINGS;
  const usable = (Array.isArray(listings) ? listings : []).filter((listing) => {
    const price = Number(listing?.totalPrice ?? listing?.price);
    return Number.isFinite(price) && price > 0;
  });
  if (!usable.length) return { tier: "none", printRun: null, listings: [], factor: 1 };

  const byRun = new Map();
  for (const listing of usable) {
    const run = printRunFromListing(listing);
    const key = run == null ? "unnumbered" : String(run);
    if (!byRun.has(key)) byRun.set(key, { printRun: run, listings: [] });
    byRun.get(key).listings.push(listing);
  }

  const target = Number.isFinite(targetPrintRun) && targetPrintRun > 0 ? targetPrintRun : null;
  const exactKey = target == null ? "unnumbered" : String(target);
  const exact = byRun.get(exactKey);
  if (exact?.listings.length) {
    return {
      tier: "exact",
      printRun: exact.printRun,
      listings: exact.listings.slice(0, maxListings),
      factor: 1,
    };
  }

  // No exact tier — rank the rest by ratio distance to the target.
  const candidates = [...byRun.values()].filter((entry) => entry.listings.length > 0);
  if (!candidates.length) return { tier: "none", printRun: null, listings: [], factor: 1 };

  const distance = (entry) => {
    if (target == null || entry.printRun == null) return Number.POSITIVE_INFINITY;
    return Math.abs(Math.log(entry.printRun / target));
  };
  const numbered = candidates.filter((entry) => entry.printRun != null);
  const pool = target != null && numbered.length ? numbered : candidates;
  pool.sort((a, b) => distance(a) - distance(b) || b.listings.length - a.listings.length);
  const nearest = pool[0];

  return {
    tier: "nearest",
    printRun: nearest.printRun,
    listings: nearest.listings.slice(0, maxListings),
    factor: scarcityFactor(target, nearest.printRun, options),
  };
}

// Percentile over a sorted numeric array (linear interpolation).
export function percentile(sortedValues, fraction) {
  if (!sortedValues.length) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const position = (sortedValues.length - 1) * Math.min(1, Math.max(0, fraction));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (position - lower);
}

// Main entry point. `listings` should already be relevance-filtered by the
// caller (isRelevantComp / filterExactMatchComps) so this only has to
// reason about price tiers, not identity.
export function computeActiveListingPrice(listings = [], metadata = {}, options = {}) {
  const targetPrintRun = derivedPrintRun(metadata);
  const tier = selectCompTier(listings, targetPrintRun, options);
  if (!tier.listings.length) {
    return {
      price: null,
      tier: "none",
      reason: "no usable active listings",
      sampleSize: 0,
      targetPrintRun: targetPrintRun ?? null,
      compPrintRun: null,
      scarcityFactor: 1,
    };
  }

  const prices = tier.listings
    .map((listing) => Number(listing?.totalPrice ?? listing?.price))
    .filter((price) => Number.isFinite(price) && price > 0)
    .sort((a, b) => a - b);

  // Active listings are asks, and unsold asks skew high — anchor low in
  // the distribution rather than at the median so the resulting price is
  // one that can actually transact.
  const fraction = Number.isFinite(options.percentile)
    ? options.percentile
    : envNumber("ACTIVE_PRICING_PERCENTILE", 0.25);
  const basis = percentile(prices, fraction);
  if (!Number.isFinite(basis) || basis <= 0) {
    return {
      price: null,
      tier: tier.tier,
      reason: "no usable prices in the selected tier",
      sampleSize: prices.length,
      targetPrintRun: targetPrintRun ?? null,
      compPrintRun: tier.printRun ?? null,
      scarcityFactor: tier.factor,
    };
  }

  const price = Math.round(basis * tier.factor * 100) / 100;
  return {
    price,
    tier: tier.tier,
    reason:
      tier.tier === "exact"
        ? `priced off ${prices.length} exact-match active listing(s)`
        : `no exact /${targetPrintRun ?? "base"} match — priced off ${prices.length} /${
            tier.printRun ?? "unnumbered"
          } listing(s) with a ${tier.factor >= 1 ? "premium" : "discount"} of ${(tier.factor * 100 - 100).toFixed(0)}%`,
    sampleSize: prices.length,
    basisPrice: Math.round(basis * 100) / 100,
    targetPrintRun: targetPrintRun ?? null,
    compPrintRun: tier.printRun ?? null,
    scarcityFactor: Math.round(tier.factor * 1000) / 1000,
    percentileUsed: fraction,
  };
}

// ---------------------------------------------------------------------------
// Unattended-repricing policy.
//
// Lives here rather than in reprice-scheduler.js on purpose: this is
// pricing policy, and keeping it in a module whose only dependency is the
// leaf card-query.js means the guardrail below is unit-testable without
// dragging in app.js (and, through it, the whole eBay/Google stack).
// ---------------------------------------------------------------------------

// Ceiling for UNATTENDED active-listing-based repricing. Active listings
// are asks rather than sales, so the scheduler may only act on them where a
// wrong price is cheap; at or above this a card still gets a priced
// suggestion in the UI, but a human approves it. Set to 0 to disable
// unattended active-listing repricing entirely.
export function autoActivePricingMaxPrice() {
  const parsed = Number(process.env.AUTO_ACTIVE_PRICING_MAX_PRICE);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10;
}

// Decides whether a card may be auto-repriced from active listings, and at
// what price.
export function computeActiveListingFallbackPrice({
  card,
  currentPrice,
  activeListings = [],
  lookupMetadata = {},
} = {}) {
  const ceiling = autoActivePricingMaxPrice();
  if (!(ceiling > 0)) {
    return { eligible: false, skippedReason: "active-fallback-disabled" };
  }
  // Gate on the CURRENT listed price: it's the known quantity, and it's what
  // bounds the downside if the computed price turns out wrong. A card with
  // no reliable current price fails this check and needs approval.
  if (!(Number.isFinite(currentPrice) && currentPrice < ceiling)) {
    return {
      eligible: false,
      skippedReason: "active-fallback-needs-approval",
      detail: {
        reason: `current price ${currentPrice} is at/above the $${ceiling} unattended ceiling — suggestion only`,
        ceiling,
      },
    };
  }
  const metadata = {
    printRun: lookupMetadata.printRun ?? card?.printRun ?? null,
    serialNumber: lookupMetadata.serialNumber ?? card?.serialNumber ?? null,
  };
  const result = computeActiveListingPrice(activeListings, metadata);
  if (!(Number.isFinite(result.price) && result.price > 0)) {
    return { eligible: false, skippedReason: "active-fallback-no-price", detail: result };
  }
  return { eligible: true, price: result.price, detail: result };
}

// ---------------------------------------------------------------------------
// Manual-price anchoring.
//
// The price written into the scan filename is a HUMAN read of the card (see
// lib/filename-price.js) and is the most trustworthy number we have: sold
// comps are gone (eBay sign-in wall) and the active-listing figure is
// derived from what other sellers are ASKING, which skews high and gets
// dragged around by thin or delusional markets.
//
// So the manual price anchors the result — but it isn't a ceiling. A card
// can genuinely heat up after it was scanned (a player pops off, a parallel
// gets chased), and the live market is the only signal that sees that. The
// rule below: never price BELOW the human's read, but allow the market to
// pull the price UP, capped at a multiple of that read so a single absurd
// asking price can't run away with it.
// ---------------------------------------------------------------------------

// How far above the manual price the live market may push. 2.0 = a card may
// list at up to double what the scanner judged, if active listings support
// it. Set to 1 to make the manual price an exact ceiling as well as a floor.
export function manualAnchorMaxMultiple() {
  const parsed = Number(process.env.MANUAL_ANCHOR_MAX_MULTIPLE);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 2;
}

// Above this many relevant sold comps, the manual filename price stops acting
// as a clamp. 3 matches the bar calculatePrice itself uses to call sold-comp
// evidence "high confidence".
export function soldCompAnchorBypassMin() {
  const parsed = Number.parseInt(process.env.MANUAL_ANCHOR_SOLD_COMP_MIN || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}

export function applyManualPriceAnchor(marketPrice, manualPrice, options = {}) {
  const manual = Number(manualPrice);
  const market = Number(marketPrice);
  const hasManual = Number.isFinite(manual) && manual > 0;
  const hasMarket = Number.isFinite(market) && market > 0;

  // No human read: fall back to the market figure unchanged.
  if (!hasManual) {
    return {
      price: hasMarket ? Math.round(market * 100) / 100 : null,
      basis: hasMarket ? "market" : "none",
      manualPrice: null,
      marketPrice: hasMarket ? market : null,
      reason: hasMarket ? "no manual price on file — using the live-listing price" : "no price available",
    };
  }
  // Human read but no usable market data: trust the human outright.
  if (!hasMarket) {
    return {
      price: Math.round(manual * 100) / 100,
      basis: "manual",
      manualPrice: manual,
      marketPrice: null,
      reason: "no usable active listings — using the manual price check",
    };
  }

  // Sold comps are the comp engine whenever they exist. The manual filename
  // price was introduced as a STAND-IN while eBay's completed listings were
  // unreachable; with real sold data back, clamping a sold-comp median to a
  // multiple of a number typed into a filename discards the better evidence.
  // Past the confidence bar, the human read is still recorded — it just stops
  // moving the price.
  const soldCompCount = Number(options.soldCompCount);
  if (Number.isFinite(soldCompCount) && soldCompCount >= soldCompAnchorBypassMin()) {
    return {
      price: Math.round(market * 100) / 100,
      basis: "sold_comps",
      manualPrice: manual,
      marketPrice: market,
      soldCompCount,
      reason: `${soldCompCount} sold comps on file — using the sold-comp price; manual check ($${manual.toFixed(2)}) kept as evidence only`,
    };
  }

  const maxMultiple = Number.isFinite(options.maxMultiple) ? options.maxMultiple : manualAnchorMaxMultiple();
  const ceiling = manual * maxMultiple;

  if (market <= manual) {
    return {
      price: Math.round(manual * 100) / 100,
      basis: "manual_floor",
      manualPrice: manual,
      marketPrice: market,
      reason: `live listings ($${market.toFixed(2)}) are at or below the manual check ($${manual.toFixed(2)}) — holding the manual price`,
    };
  }
  if (market >= ceiling) {
    return {
      price: Math.round(ceiling * 100) / 100,
      basis: "manual_capped",
      manualPrice: manual,
      marketPrice: market,
      reason: `live listings ($${market.toFixed(2)}) run hot but exceed ${maxMultiple}x the manual check — capping at $${ceiling.toFixed(2)}`,
    };
  }
  return {
    price: Math.round(market * 100) / 100,
    basis: "market_hot",
    manualPrice: manual,
    marketPrice: market,
    reason: `live listings ($${market.toFixed(2)}) run above the manual check ($${manual.toFixed(2)}) — following the market`,
  };
}
