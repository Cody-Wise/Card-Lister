import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildConditionDescriptors } from "./ebay-condition.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const configPath = path.join(rootDir, "data", "ebay-config.json");

const runtimeOverrides = {};

async function loadEbayConfig() {
  try {
    const data = await fs.readFile(configPath, "utf8");
    Object.assign(runtimeOverrides, JSON.parse(data));
  } catch {
    // file doesn't exist yet — that's fine
  }
}

async function saveEbayConfig() {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(runtimeOverrides, null, 2));
}

// Load persisted config on module init; request paths that depend on auth await this promise.
const ebayConfigReady = loadEbayConfig();

function fakeId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function readBestOfferPct(name, fallback) {
  const parsed = Number.parseFloat(process.env[name] || "");
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

// Auto-accept/auto-decline Best Offer thresholds as a percentage of the
// listing's own asking price (user spec 2026-07-09): accept at or above 85%
// of asking for listings up to $50, 90% above $50; decline at or below 50%.
// Returns null when there's no usable price (thresholds are meaningless
// without one; eBay's plain bestOfferEnabled boolean still applies).
//
// Field-shape note, learned the hard way: the REST Inventory API names
// these autoAcceptPrice/autoDeclinePrice inside listingPolicies
// .bestOfferTerms, and the Trading API wants BestOfferAutoAcceptPrice/
// MinimumBestOfferPrice under Item.ListingDetails (NOT BestOfferDetails).
// Both were confirmed live after four earlier spikes false-negatived by
// sending wrong names/placement — eBay silently drops unrecognized fields
// rather than erroring.
export function computeBestOfferThresholds(price) {
  const numeric = Number(price);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const highTierStart = (() => {
    const parsed = Number.parseFloat(process.env.BEST_OFFER_AUTO_ACCEPT_HIGH_TIER_THRESHOLD || "");
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
  })();
  const acceptPct = numeric > highTierStart
    ? readBestOfferPct("BEST_OFFER_AUTO_ACCEPT_PCT_HIGH_TIER", 0.9)
    : readBestOfferPct("BEST_OFFER_AUTO_ACCEPT_PCT", 0.85);
  const declinePct = readBestOfferPct("BEST_OFFER_AUTO_DECLINE_PCT", 0.5);
  if (declinePct >= acceptPct) {
    // A misconfigured env pair (decline at/above accept) would make eBay
    // reject the listing revision outright — fall back to the defaults
    // rather than propagating a broken configuration to live listings.
    return {
      autoAcceptPrice: Number((numeric * (numeric > highTierStart ? 0.9 : 0.85)).toFixed(2)),
      autoDeclinePrice: Number((numeric * 0.5).toFixed(2)),
    };
  }
  return {
    autoAcceptPrice: Number((numeric * acceptPct).toFixed(2)),
    autoDeclinePrice: Number((numeric * declinePct).toFixed(2)),
  };
}

function normalizeBestOfferTerms(bestOfferTerms = {}, price = null) {
  const thresholds = computeBestOfferThresholds(price);
  return {
    ...(bestOfferTerms || {}),
    bestOfferEnabled: true,
    // Recomputed from the current price on every create/update, so the
    // thresholds track price changes (including the repricer's) instead of
    // fossilizing at whatever the price was on first publish.
    ...(thresholds
      ? {
          autoAcceptPrice: { value: thresholds.autoAcceptPrice.toFixed(2), currency: "USD" },
          autoDeclinePrice: { value: thresholds.autoDeclinePrice.toFixed(2), currency: "USD" },
        }
      : {}),
  };
}

const AUCTION_LISTING_DURATIONS = new Set([
  "DAYS_1",
  "DAYS_3",
  "DAYS_5",
  "DAYS_7",
  "DAYS_10",
  "GTC",
]);
const DEFAULT_AUCTION_DURATION = "DAYS_7";

function normalizeMoneyValue(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = raw.replace(/[$,\s]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePriceFromSummary(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") return normalizeMoneyValue(value);
  if (typeof value === "object") return normalizeMoneyValue(value.value);
  return null;
}

function toMoneyValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return normalizeMoneyValue(value);
  if (typeof value === "object") {
    if (typeof value.value === "number") return Number.isFinite(value.value) ? value.value : null;
    if (typeof value.value === "string") return normalizeMoneyValue(value.value);
    if (typeof value.amount === "number") return Number.isFinite(value.amount) ? value.amount : null;
    if (typeof value.amount === "string") return normalizeMoneyValue(value.amount);
    if (typeof value.value === "object" && value.value?.value != null) {
      return toMoneyValue(value.value.value);
    }
  }
  return null;
}

function safeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function extractLineItemPrice(lineItem = {}) {
  const candidates = [
    lineItem.lineItemCost,
    lineItem.totalAmount,
    lineItem.totalPrice,
    lineItem.price,
    lineItem.unitPrice,
    lineItem.cost,
    lineItem.pricingSummary?.grossPrice,
    lineItem.lineItemCost?.value,
    lineItem.lineItemCost?.value?.value,
  ];
  for (const candidate of candidates) {
    const parsed = toMoneyValue(candidate);
    if (parsed != null) return parsed;
  }
  return null;
}

export function normalizeOrderDate(order) {
  return normalizeOrderLineDate(order);
}

export function normalizeOrderLineDate(order, lineItem = null) {
  const candidates = [
    order?.creationDate,
    order?.createdDate,
    order?.createdDateTime,
    order?.lastModifiedDate,
    order?.orderCreatedDate,
    order?.orderDate,
    order?.paymentDate,
    order?.paidDate,
    order?.paymentSummary?.paymentDate,
    order?.paymentSummary?.paidDate,
    order?.pricingSummary?.paymentDate,
  ];
  const lineItems = lineItem ? [lineItem] : Array.isArray(order?.lineItems) ? order.lineItems : [];
  for (const currentLineItem of lineItems) {
    candidates.push(
      currentLineItem?.transactionDate,
      currentLineItem?.soldDate,
      currentLineItem?.saleDate,
      currentLineItem?.createdDate,
      currentLineItem?.creationDate,
      currentLineItem?.lastModifiedDate,
      currentLineItem?.deliveryDate,
      currentLineItem?.shippedDate,
    );
  }
  let latest = null;
  for (const candidate of candidates) {
    const parsed = safeDate(candidate);
    if (!parsed) continue;
    if (!latest || parsed.getTime() > latest.getTime()) latest = parsed;
  }
  return latest ? latest.toISOString() : null;
}

function formatMonthKey(value) {
  const parsed = safeDate(value);
  if (!parsed) return null;
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  return `${parsed.getUTCFullYear()}-${month}`;
}

function isLikelySalesOrder(order) {
  if (!order || typeof order !== "object") return false;
  const fulfillmentStatus = String(order.orderFulfillmentStatus || order.fulfillmentStatus || "").toLowerCase();
  if (["cancelled", "canceled", "voided", "rejected"].includes(fulfillmentStatus)) {
    return false;
  }
  const orderStatus = String(order.orderStatus || order.status || "").toLowerCase();
  if (["cancelled", "canceled", "voided", "rejected"].includes(orderStatus)) {
    return false;
  }
  return true;
}

function normalizeOrderDateRange({ startDate, endDate, days }) {
  const fallbackDays = Number.isFinite(days) && days > 0 ? days : 180;
  const resolvedEnd = safeDate(endDate) || new Date();
  const resolvedStart = safeDate(startDate) || new Date(resolvedEnd.getTime() - fallbackDays * 24 * 60 * 60 * 1000);
  return {
    startDate: resolvedStart.toISOString(),
    endDate: resolvedEnd.toISOString(),
  };
}

const ORDER_FETCH_LOOKBACK_DAYS = 120;

function buildFulfillmentOrderFetchWindow(range) {
  const requestedStart = safeDate(range?.startDate);
  const requestedEnd = safeDate(range?.endDate);
  if (!requestedStart || !requestedEnd) {
    return {
      requestedStart,
      requestedEnd,
      queryStart: range?.startDate ?? null,
      queryEnd: range?.endDate ?? null,
    };
  }
  const queryStart = new Date(
    requestedStart.getTime() - ORDER_FETCH_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );
  return {
    requestedStart,
    requestedEnd,
    queryStart: queryStart.toISOString(),
    queryEnd: requestedEnd.toISOString(),
  };
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function toCountValue(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function extractListingIdFromUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;
  // eBay listing URLs are either bare (".../itm/236917541201") or
  // SEO-friendly with a title slug before the ID
  // (".../itm/2024-25-Panini-Select-.../236298326630") — the real numeric
  // ID is always the LAST path segment. Matching the first run of digits
  // after "/itm/" (the old pattern) grabs the leading year out of a
  // slugged URL instead, which is wrong far more often than not for sports
  // cards. See the identical fix + live repro in ebay-best-offers.js's
  // extractItemIdFromListingUrl.
  const pathOnly = raw.split("?")[0];
  const match = /\/itm\/(?:[^/]*\/)?(\d+)\/?$/i.exec(pathOnly);
  return match?.[1] || null;
}

function normalizeAuctionDuration(value) {
  const raw = String(value || "").trim().toUpperCase();
  return AUCTION_LISTING_DURATIONS.has(raw) ? raw : null;
}

function getEbayListingConfig(source = {}, requestPayload = {}) {
  const requestFormat = String(requestPayload.format || "").toUpperCase();
  const format =
    source.ebayListingFormat === "AUCTION"
      ? "AUCTION"
      : requestFormat === "AUCTION"
        ? "AUCTION"
        : "FIXED_PRICE";
  const has = Object.prototype.hasOwnProperty;
  const pricingSummary = requestPayload.pricingSummary || {};

  return {
    format,
    listingDuration: format === "AUCTION"
      ? normalizeAuctionDuration(
          has.call(source, "ebayAuctionDuration")
            ? source.ebayAuctionDuration
            : requestPayload.listingDuration,
        ) || DEFAULT_AUCTION_DURATION
      : null,
    auctionStartPrice: has.call(source, "ebayAuctionStartPrice")
      ? normalizeMoneyValue(source.ebayAuctionStartPrice)
      : parsePriceFromSummary(pricingSummary.auctionStartPrice),
    auctionReservePrice: has.call(source, "ebayAuctionReservePrice")
      ? normalizeMoneyValue(source.ebayAuctionReservePrice)
      : parsePriceFromSummary(pricingSummary.auctionReservePrice),
    hasAuctionReservePrice: has.call(source, "ebayAuctionReservePrice"),
    auctionBuyItNowPrice: has.call(source, "ebayAuctionBuyItNowPrice")
      ? normalizeMoneyValue(source.ebayAuctionBuyItNowPrice)
      : parsePriceFromSummary(pricingSummary.price),
    hasAuctionBuyItNowPrice: has.call(source, "ebayAuctionBuyItNowPrice"),
    fixedPrice: has.call(source, "recommendedPrice")
      ? normalizeMoneyValue(source.recommendedPrice)
      : null,
  };
}

function buildEbayPricingSummary({ listingConfig, cardPrice, existingPricing = {} }) {
  const updatedPricing = {
    ...existingPricing,
  };
  if (listingConfig.format === "AUCTION") {
    const startValue =
      listingConfig.auctionStartPrice != null
        ? listingConfig.auctionStartPrice
        : Number.isFinite(cardPrice)
          ? cardPrice
          : parsePriceFromSummary(existingPricing.auctionStartPrice);

    if (Number.isFinite(startValue)) {
      updatedPricing.auctionStartPrice = {
        currency: "USD",
        value: String(startValue),
      };
    } else {
      delete updatedPricing.auctionStartPrice;
    }

    if (listingConfig.hasAuctionReservePrice) {
      if (Number.isFinite(listingConfig.auctionReservePrice)) {
        updatedPricing.auctionReservePrice = {
          currency: "USD",
          value: String(listingConfig.auctionReservePrice),
        };
      } else {
        delete updatedPricing.auctionReservePrice;
      }
    } else if (!Object.prototype.hasOwnProperty.call(updatedPricing, "auctionReservePrice")) {
      delete updatedPricing.auctionReservePrice;
    }

    if (listingConfig.hasAuctionBuyItNowPrice) {
      if (Number.isFinite(listingConfig.auctionBuyItNowPrice)) {
        updatedPricing.price = {
          currency: "USD",
          value: String(listingConfig.auctionBuyItNowPrice),
        };
      } else {
        delete updatedPricing.price;
      }
    } else {
      delete updatedPricing.price;
    }
    delete updatedPricing.fixedPrice;
    return updatedPricing;
  }

  const fallbackFixed =
    listingConfig.fixedPrice != null
      ? listingConfig.fixedPrice
      : Number.isFinite(cardPrice)
        ? cardPrice
        : parsePriceFromSummary(existingPricing.price);
  if (Number.isFinite(fallbackFixed)) {
    updatedPricing.price = {
      currency: "USD",
      value: String(fallbackFixed),
    };
  } else {
    delete updatedPricing.price;
  }
  delete updatedPricing.auctionStartPrice;
  delete updatedPricing.auctionReservePrice;
  return updatedPricing;
}

export function setEbayConfig(overrides) {
  Object.assign(runtimeOverrides, overrides);
  saveEbayConfig();
}

const EBAY_BASE_AUTH_SCOPE = "https://api.ebay.com/oauth/api_scope";
const EBAY_AUTH_SCOPES = process.env.EBAY_AUTH_SCOPES || [
  EBAY_BASE_AUTH_SCOPE,
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly",
].join(" ");
const EBAY_MINIMAL_AUTH_SCOPES = [
  EBAY_BASE_AUTH_SCOPE,
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
].join(" ");
const EBAY_PORTAL_AUTH_SCOPES = [
  EBAY_BASE_AUTH_SCOPE,
  "https://api.ebay.com/oauth/api_scope/sell.marketing.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.marketing",
  "https://api.ebay.com/oauth/api_scope/sell.inventory.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.analytics.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.finances",
  "https://api.ebay.com/oauth/api_scope/sell.payment.dispute",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.reputation",
  "https://api.ebay.com/oauth/api_scope/sell.reputation.readonly",
  "https://api.ebay.com/oauth/api_scope/commerce.notification.subscription",
  "https://api.ebay.com/oauth/api_scope/commerce.notification.subscription.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.stores",
  "https://api.ebay.com/oauth/api_scope/sell.stores.readonly",
  "https://api.ebay.com/oauth/scope/sell.edelivery",
  "https://api.ebay.com/oauth/api_scope/commerce.vero",
  "https://api.ebay.com/oauth/api_scope/sell.inventory.mapping",
  "https://api.ebay.com/oauth/api_scope/commerce.message",
  "https://api.ebay.com/oauth/api_scope/commerce.feedback",
  "https://api.ebay.com/oauth/api_scope/commerce.shipping",
].join(" ");
const EBAY_AUTH_CALLBACK_PATH = "/api/ebay/auth-callback";
const DEFAULT_EBAY_RUNAME = "Bigfoot_Boys_Ca-BigfootB-Dimens-ggyfkvlz";
const EBAY_AUTH_STATE_TTL_MS = 10 * 60 * 1000;
const LOCAL_FALLBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "::"]);
const ebayAuthStateMap = new Map();

function createEbayAuthState(redirectUri) {
  const state = `ebay${randomBytes(6).toString("hex")}`;
  ebayAuthStateMap.set(state, {
    redirectUri,
    createdAt: Date.now(),
  });
  return state;
}

function getEbayAuthState(state) {
  if (!state) return null;
  const entry = ebayAuthStateMap.get(state);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > EBAY_AUTH_STATE_TTL_MS) {
    ebayAuthStateMap.delete(state);
    return null;
  }
  ebayAuthStateMap.delete(state);
  return entry.redirectUri;
}

function normalizeProtocol(value, fallback = "http") {
  const raw = String(value || fallback).toLowerCase().trim();
  if (raw.startsWith("https")) return "https";
  if (raw.startsWith("http")) return "http";
  return fallback;
}

function looksLikeUrl(value = "") {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function isLikelyRuName(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return false;
  if (looksLikeUrl(raw)) return false;
  return !raw.includes("/") && !raw.includes(":");
}

function isLocalhostHost(hostname = "") {
  const host = String(hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function resolveLocalhostHost(hostname = "") {
  const host = String(hostname || "").toLowerCase();
  if (host === "0.0.0.0" || host === "::" || host === "[::]") return "localhost";
  return host;
}

function extractHostPort(rawHost = "", fallbackPort = "") {
  const source = String(rawHost || "").trim();
  let host = "";
  let port = String(fallbackPort || "").trim();
  if (!source) return { host, port };
  const candidate = source.startsWith("http://") || source.startsWith("https://")
    ? source
    : `http://${source}`;
  try {
    const parsed = new URL(candidate);
    host = resolveLocalhostHost(parsed.hostname);
    port = port || parsed.port;
  } catch {
    const ipv6Match = /^\[([^\]]+)\](?::(\d+))?$/.exec(source);
    if (ipv6Match) {
      host = resolveLocalhostHost(ipv6Match[1]);
      port = port || ipv6Match[2] || "";
    } else {
      const ipv4Match = /^([0-9.]+|[a-zA-Z0-9\-.]+)(?::(\d+))?$/.exec(source);
      if (ipv4Match) {
        host = resolveLocalhostHost(ipv4Match[1]);
        port = port || ipv4Match[2] || "";
      }
    }
  }
  return { host, port };
}

function normalizeRedirectHost(value) {
  if (!value) return "";
  const trimmed = String(value).trim();
  if (!trimmed) return "";

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    if (!parsed.host) return "";
    const path = parsed.pathname.replace(/\/+$/, "");
    const normalizedPath = (!path || path === "/" ? EBAY_AUTH_CALLBACK_PATH : path).trim();
    const callbackPath = normalizedPath.toLowerCase().endsWith(EBAY_AUTH_CALLBACK_PATH.toLowerCase())
      ? normalizedPath
      : EBAY_AUTH_CALLBACK_PATH;
    return `${parsed.protocol}//${parsed.host}${callbackPath}`;
  } catch {
    return trimmed.replace(/^\/+|\/+$/g, "");
  }
}

function buildRedirectUriFromHost(hostValue, protocolValue = "http") {
  if (!hostValue) return null;

  const cleanHost = String(hostValue).replace(/\/+$/, "");
  if (!cleanHost) return null;

  const protocol = normalizeProtocol(protocolValue);
  if (cleanHost.toLowerCase().startsWith("http://") || cleanHost.toLowerCase().startsWith("https://")) {
    return cleanHost.endsWith(EBAY_AUTH_CALLBACK_PATH)
      ? cleanHost
      : `${cleanHost.replace(/\/+$/, "")}${EBAY_AUTH_CALLBACK_PATH}`;
  }
  return `${protocol}://${cleanHost}${EBAY_AUTH_CALLBACK_PATH}`;
}

function buildRedirectFromRequestHint(requestHint = {}) {
  const requestHost = String(requestHint.host || requestHint.hostname || "").trim();
  const parsedHost = extractHostPort(requestHost, requestHint.port);
  const normalizedHost = resolveLocalhostHost(parsedHost.host);
  const parsedPort = parsedHost.port;
  const requestPort = String(
    parsedPort || requestHint.port || process.env.PORT || "3000",
  ).trim();
  const hostWithoutPort = normalizedHost || "localhost";
  const host = `${hostWithoutPort}:${requestPort}`;
  return buildRedirectUriFromHost(host, requestHint.protocol);
}

function getEbayRedirectUri(requestHint = {}) {
  const requestRedirectUri = buildRedirectFromRequestHint(requestHint);
  const requestHost = resolveLocalhostHost(
    String(requestHint.hostname || requestHint.host || "").trim().split(":")[0],
  );
  const explicitRedirectUri = String(process.env.EBAY_REDIRECT_URI || "").trim();
  if (explicitRedirectUri && !isLikelyRuName(explicitRedirectUri)) {
    const normalized = normalizeRedirectHost(explicitRedirectUri);
    if (normalized && normalized.toLowerCase().endsWith(EBAY_AUTH_CALLBACK_PATH.toLowerCase())) return normalized;
    const redirectFromHost = buildRedirectUriFromHost(normalized, requestHint.protocol);
    if (redirectFromHost) return redirectFromHost;
    return null;
  }

  const hostOverride = String(process.env.EBAY_REDIRECT_HOST || "").trim();
  if (hostOverride && !isLikelyRuName(hostOverride)) {
    const parsedHostOverride = extractHostPort(hostOverride);
    const resolvedHostOverride = parsedHostOverride.host || "localhost";
    const resolvedPortOverride = parsedHostOverride.port || String(requestHint.port || process.env.PORT || "3000").trim();
    const redirectFromHost = buildRedirectUriFromHost(
      `${resolvedHostOverride}:${resolvedPortOverride}`,
      requestHint.protocol,
    );
    if (redirectFromHost) return redirectFromHost;
  }

  if (requestRedirectUri) {
    return requestRedirectUri;
  }

  const hostname = String(requestHint.hostname || "localhost").trim() || "localhost";
  const port = String(requestHint.port || process.env.PORT || "3000").trim();
  const host = /:\d+$/.test(hostname) ? hostname : `${hostname}:${port}`;
  return buildRedirectUriFromHost(host, requestHint.protocol);
}

function getEbayRuName() {
  const candidates = [
    process.env.EBAY_RUNAME,
    process.env.EBAY_RU_NAME,
    process.env.EBAY_REDIRECT_URI,
    process.env.EBAY_REDIRECT_HOST,
    DEFAULT_EBAY_RUNAME,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (isLikelyRuName(value)) return value;
  }
  return "";
}

function getOAuthConfig(requestHint = {}) {
  const redirectUri = requestHint.redirectUri || getEbayRedirectUri(requestHint);
  const ruName = getEbayRuName();
  const env = process.env.EBAY_ENV === "sandbox" ? "sandbox" : "production";
  const baseUrl = env === "sandbox" ? "https://auth.sandbox.ebay.com" : "https://auth.ebay.com";
  const apiBase = env === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
  return {
    env,
    baseUrl,
    apiBase,
    clientId: process.env.EBAY_CLIENT_ID || "",
    clientSecret: process.env.EBAY_CLIENT_SECRET || "",
    redirectUri,
    ruName,
  };
}

function getRequestedEbayScopes(options = {}) {
  if (options.scopeProfile === "portal") return EBAY_PORTAL_AUTH_SCOPES;
  if (options.scopeProfile === "base") return EBAY_BASE_AUTH_SCOPE;
  if (options.scopeProfile === "minimal") return EBAY_MINIMAL_AUTH_SCOPES;
  return EBAY_AUTH_SCOPES;
}

export function getEbayAuthUrl(requestHint = {}, options = {}) {
  const oa = getOAuthConfig(requestHint);
  if (!oa.redirectUri) throw new Error("Unable to resolve eBay callback URL");
  if (!oa.ruName) throw new Error("Missing EBAY_RUNAME");
  if (!oa.clientId) throw new Error("Missing EBAY_CLIENT_ID");
  const state = typeof options.state === "string" ? options.state.trim() : "";
  const scopes = getRequestedEbayScopes(options);
  const params = [
    ["client_id", oa.clientId],
    ["response_type", "code"],
    ["redirect_uri", oa.ruName],
    ["scope", scopes],
  ];
  if (state) params.push(["state", state]);
  const query = params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return `${oa.baseUrl}/oauth2/authorize?${query}`;
}

export function createEbayAuthUrlState(requestHint = {}) {
  const redirectUri = getEbayRedirectUri(requestHint);
  return {
    state: createEbayAuthState(redirectUri),
    redirectUri,
  };
}

export function consumeEbayAuthUrlState(state = "") {
  return getEbayAuthState(state);
}

export async function exchangeEbayCode(code, requestHint = {}) {
  const oa = getOAuthConfig(requestHint);
  if (!oa.clientId || !oa.clientSecret) throw new Error("Missing EBAY_CLIENT_ID or EBAY_CLIENT_SECRET");
  if (!oa.ruName) throw new Error("Missing EBAY_RUNAME");
  const basic = Buffer.from(`${oa.clientId}:${oa.clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: oa.ruName,
  });
  const res = await fetch(`${oa.apiBase}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // ignore JSON parse failures
  }
  if (!res.ok) {
    const details = [];
    if (data && typeof data === "object") {
      if (data.error) details.push(`error=${data.error}`);
      if (data.error_description) details.push(`error_description=${data.error_description}`);
      if (data.error_id) details.push(`error_id=${data.error_id}`);
      if (data.http_status_code) details.push(`http_status_code=${data.http_status_code}`);
      if (data.error_uri) details.push(`error_uri=${data.error_uri}`);
    } else {
      details.push(`status=${res.status}`);
    }
    throw new Error(
      `eBay OAuth token exchange failed for redirect_uri=${oa.ruName} callback_url=${oa.redirectUri}: ${details.join(" | ")}`,
    );
  }
  return data;
}

export async function refreshEbayToken() {
  const refreshToken = runtimeOverrides.refreshToken || process.env.EBAY_REFRESH_TOKEN;
  if (!refreshToken) throw new Error("No refresh token available");
  const oa = getOAuthConfig();
  const basic = Buffer.from(`${oa.clientId}:${oa.clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch(`${oa.apiBase}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = await res.json();
  if (!res.ok) {
    const message = data.error_description || data.error || res.status;
    const lowerMessage = String(message).toLowerCase();
    if (lowerMessage.includes("scope") || lowerMessage.includes("invalid")) {
      runtimeOverrides.userAccessToken = "";
      runtimeOverrides.refreshToken = "";
      saveEbayConfig().catch(() => {});
    }
    throw new Error(`eBay token refresh failed: ${message}`);
  }
  runtimeOverrides.userAccessToken = data.access_token;
  if (data.refresh_token) runtimeOverrides.refreshToken = data.refresh_token;
  return data;
}

function getConfig() {
  const environment = process.env.EBAY_ENV === "sandbox" ? "sandbox" : "production";
  const baseUrl =
    environment === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
  return {
    environment,
    baseUrl,
    userAccessToken: runtimeOverrides.userAccessToken || process.env.EBAY_USER_ACCESS_TOKEN || process.env.EBAY_USER_TOKEN || "",
    marketplaceId: runtimeOverrides.marketplaceId || process.env.EBAY_MARKETPLACE_ID || "EBAY_US",
    merchantLocationKey: runtimeOverrides.merchantLocationKey || process.env.EBAY_MERCHANT_LOCATION_KEY || "",
    categoryId: runtimeOverrides.categoryId || process.env.EBAY_CATEGORY_ID || "",
    tradingCardGameCategoryId: process.env.EBAY_TCG_CATEGORY_ID || "183454",
    nonSportTradingCardCategoryId: process.env.EBAY_NONSPORT_TRADING_CARD_CATEGORY_ID || "183050",
    paymentPolicyId: runtimeOverrides.paymentPolicyId || process.env.EBAY_PAYMENT_POLICY_ID || "",
    fulfillmentPolicyId:
      runtimeOverrides.fulfillmentPolicyId ||
      process.env.EBAY_FULFILLMENT_POLICY_GROUND_ADVANTAGE_ID ||
      process.env.EBAY_FULFILLMENT_POLICY_ID ||
      "",
    lessThan20FulfillmentPolicyId:
      runtimeOverrides.lessThan20FulfillmentPolicyId ||
      runtimeOverrides.fulfillmentPolicyId ||
      process.env.EBAY_FULFILLMENT_POLICY_LESS_THAN_20_ID ||
      process.env.EBAY_FULFILLMENT_POLICY_GROUND_ADVANTAGE_ID ||
      process.env.EBAY_FULFILLMENT_POLICY_ID ||
      "",
    lessThan20MachinableFulfillmentPolicyId:
      runtimeOverrides.lessThan20MachinableFulfillmentPolicyId ||
      runtimeOverrides.fulfillmentPolicyId ||
      process.env.EBAY_FULFILLMENT_POLICY_LESS_THAN_20_MACHINEABLE_ID ||
      process.env.EBAY_FULFILLMENT_POLICY_LESS_THAN_20_ID ||
      process.env.EBAY_FULFILLMENT_POLICY_GROUND_ADVANTAGE_ID ||
      process.env.EBAY_FULFILLMENT_POLICY_ID ||
      "",
    returnPolicyId: runtimeOverrides.returnPolicyId || process.env.EBAY_RETURN_POLICY_ID || "",
  };
}

function hasLiveConfig() {
  const config = getConfig();
  return Boolean(
    config.userAccessToken &&
    config.merchantLocationKey &&
    config.categoryId &&
    config.paymentPolicyId &&
    (config.fulfillmentPolicyId || config.lessThan20FulfillmentPolicyId) &&
    config.returnPolicyId,
  );
}

function getCardPrice(card) {
  const rawPrice = card.recommendedPrice ?? card.price ?? 0;
  const price = Number(rawPrice);
  return Number.isFinite(price) ? price : 0;
}

function isThickCard(card) {
  return Boolean(
    card.isThick ||
    card.isThickCard ||
    card.cardThickness === "thick" ||
    card.thickness === "thick" ||
    card.thicknessClass === "thick",
  );
}

function isGradedCard(card) {
  return card.candidateCondition === "graded" || Boolean(card.gradedFlag);
}

export function getFulfillmentPolicyIdForCard(card) {
  const config = getConfig();
  if (isGradedCard(card)) {
    // A graded slab is rigid and too thick for eBay Standard Envelope (the
    // service on both <$20 policies — confirmed live via eBay's Account
    // API) regardless of price, so it always ships Ground Advantage
    // instead. Checked before the price branch below on purpose: a cheap
    // graded card would otherwise fall into the <$20 envelope policies
    // just like a cheap raw card, which doesn't fit a slab.
    return config.fulfillmentPolicyId;
  }
  const price = getCardPrice(card);
  if (price >= 20) {
    return config.fulfillmentPolicyId;
  }
  if (isThickCard(card)) {
    return (
      config.lessThan20MachinableFulfillmentPolicyId ||
      config.lessThan20FulfillmentPolicyId ||
      config.fulfillmentPolicyId
    );
  }
  return config.lessThan20FulfillmentPolicyId || config.fulfillmentPolicyId;
}

const MANUFACTURER_MAP = {
  topps: "Topps",
  bowman: "Bowman",
  panini: "Panini",
  "upper deck": "Upper Deck",
  skybox: "SkyBox",
  fleer: "Fleer",
  donruss: "Donruss",
  stadium: "Stadium Club",
  ultra: "Ultra",
  score: "Score",
  leaf: "Leaf",
  parkhurst: "Parkhurst",
  ud: "Upper Deck",
};

function inferBrand(setName) {
  const key = String(setName || "").toLowerCase();
  for (const [token, brand] of Object.entries(MANUFACTURER_MAP)) {
    if (key.includes(token)) return brand;
  }
  return null;
}

function inferTradingCardKind(setName, card = {}) {
  const haystack = String(
    [
      card.candidateSport,
      card.sport,
      setName,
      card.candidateSetName,
      card.ebayTitle,
      card.candidatePlayer,
      card.playerName,
      card.notes,
    ]
      .filter(Boolean)
      .join(" "),
  ).toLowerCase();
  if (!haystack) return null;
  if (/\b(pokemon|pok[eé]mon|magic|mtg|yugioh|yu gi oh|lorcana|one piece|digimon)\b/.test(haystack)) {
    return "tcg";
  }
  if (/\b(star wars|marvel|dc|garbage pail|non sport|non-sport)\b/.test(haystack)) {
    return "non_sport";
  }
  return null;
}

function inferSport(setName, card) {
  // Cards imported via the TCG tab are explicitly, permanently flagged
  // non-sports at import time — trust that over candidateSport, which OCR
  // freely overwrites and can easily mis-tag a TCG card with a real sport
  // name (see isTcgImport in drive-routes.js and resolveCategoryIdForCard
  // above, which applies the same rule for eBay category selection).
  if (card.isTcgImport) return "Trading Cards";
  if (card.candidateSport || card.sport) return card.candidateSport || card.sport;
  const key = String(setName || "").toLowerCase();
  if (/\b(pokemon|pok[eé]mon|magic|mtg|yugioh|yu gi oh|lorcana|one piece|digimon|star wars|marvel|dc|non sport|non-sport)\b/i.test(key)) {
    return "Trading Cards";
  }
  if (/\b(wwe|wwf|wrestling|aew|wcw)\b/i.test(key)) return "Wrestling";
  // Explicit sport-name keywords first
  if (/football|gridiron/i.test(key)) return "Football";
  if (/baseball/i.test(key)) return "Baseball";
  if (/basketball|hoops|court/i.test(key)) return "Basketball";
  if (/hockey/i.test(key)) return "Hockey";
  if (/soccer/i.test(key)) return "Soccer";
  if (/ufc|mma/i.test(key)) return "MMA";
  // Fall back to brand/league keywords
  if (/topps|bowman|donruss|stadium|select/i.test(key)) return "Baseball";
  if (/contenders/i.test(key)) return "Football";
  if (/ud|upper deck/i.test(key)) return "Hockey";
  if (/uefa/i.test(key)) return "Soccer";
  return null;
}

export function resolveCategoryIdForCard(card = {}) {
  const config = getConfig();
  if (card.ebayCategoryId) return card.ebayCategoryId;
  const setName = card.candidateSetName || card.setName;
  // Cards imported via the TCG tab are explicitly, permanently flagged
  // non-sports at import time (see isTcgImport in drive-routes.js) — trust
  // that over the keyword-based inference below, which only catches a card
  // if OCR happens to surface a recognizable TCG/non-sport keyword in the
  // set name and otherwise silently falls through to the sports category.
  if (card.isTcgImport) {
    const kind = inferTradingCardKind(setName, card);
    if (kind === "non_sport") {
      return config.nonSportTradingCardCategoryId || config.tradingCardGameCategoryId || config.categoryId;
    }
    return config.tradingCardGameCategoryId || config.nonSportTradingCardCategoryId || config.categoryId;
  }
  const sport = inferSport(setName, card);
  if (sport === "Trading Cards") {
    const kind = inferTradingCardKind(setName, card);
    if (kind === "tcg") {
      return config.tradingCardGameCategoryId || config.nonSportTradingCardCategoryId || config.categoryId;
    }
    return config.nonSportTradingCardCategoryId || config.tradingCardGameCategoryId || config.categoryId;
  }
  return config.categoryId;
}

function buildEBayTitle(card) {
  const year = card.candidateYear || card.year;
  const setName = card.candidateSetName || card.setName;
  const player = card.candidatePlayer || card.playerName;
  const cardNum = card.candidateCardNumber || card.cardNumber;
  const rawParallel = card.candidateParallel && card.candidateParallel !== "Base" ? card.candidateParallel : null;
  const parallel = sanitizeParallel(rawParallel);
  const grade = card.candidateGrade;
  const isAuto = card.candidateAutoHint;
  const isRookie = card.candidateRookieFlag;
  const variantLabel = card.candidateVariantLabel && card.candidateVariantLabel !== "Base" ? card.candidateVariantLabel : null;
  const isRatedRookie = variantLabel === "Rated Rookie";
  const rookieLabel = isRatedRookie ? "Rated Rookie RC" : isRookie ? "RC" : null;
  const serial = card.serialNumber;
  const isGraded = card.candidateCondition === "graded" || card.gradedFlag;
  const yearStr = year ? String(year) : null;
  const yearPrefix = yearStr && setName && setName.startsWith(yearStr) ? null : yearStr;

  // Graded-card titles need the grader (PSA, BGS, ...) alongside the grade
  // number — "PSA 10", not just "10" — since buyers search/filter by
  // grader. normalizeGradedField/inferGradingCompany already do this same
  // lookup for the item-specifics table; reused here so the title and
  // specifics never disagree on which grader is shown.
  const gradingCompany = isGraded ? normalizeGradedField(card.gradingCompany) || inferGradingCompany(grade) : null;
  const gradeAlreadyHasGrader =
    gradingCompany && grade && new RegExp(`^${gradingCompany}\\b`, "i").test(String(grade).trim());
  const gradeLabel = grade ? (gradingCompany && !gradeAlreadyHasGrader ? `${gradingCompany} ${grade}` : grade) : null;
  const gradedNoNumberLabel = isGraded && !grade ? (gradingCompany ? `${gradingCompany} Graded` : "Graded") : null;

  const parts = [
    yearPrefix,
    setName,
    player,
    cardNum ? `#${cardNum}` : null,
    parallel,
    variantLabel && !isRatedRookie && variantLabel !== parallel ? variantLabel : null,
    isAuto ? "Autographed" : null,
    rookieLabel,
    gradeLabel,
    gradedNoNumberLabel,
    serial,
  ].filter(Boolean);

  let title = parts.join(" ").replace(/\s+/g, " ").trim();

  if (title.length > 80) {
    const hasSerial = serial && title.includes(serial);
    if (hasSerial) {
      title = parts.filter((p) => p !== serial).join(" ").replace(/\s+/g, " ").trim();
    }
  }

  if (title.length > 80) {
    const hasGrade = gradeLabel && title.includes(gradeLabel);
    if (hasGrade) {
      title = parts.filter((p) => p !== gradeLabel && (serial ? p !== serial : true)).join(" ").replace(/\s+/g, " ").trim();
    }
  }

  if (title.length > 80) {
    const hasRookie = rookieLabel && title.includes(rookieLabel);
    if (hasRookie) {
      title = parts.filter((p) => p !== rookieLabel && (serial && gradeLabel ? ![serial, gradeLabel].includes(p) : true)).join(" ").replace(/\s+/g, " ").trim();
    }
  }

  if (title.length > 80) {
    title = title.slice(0, 77).trim().replace(/\s+\S*$/, "") + "...";
  }

  return title;
}

async function buildEBayDescription(card) {
  const year = card.candidateYear || card.year;
  const setName = card.candidateSetName || card.setName;
  const player = card.candidatePlayer || card.playerName;
  const cardNum = card.candidateCardNumber || card.cardNumber;
  const parallel = card.candidateParallel && card.candidateParallel !== "Base" ? card.candidateParallel : null;
  const grade = card.candidateGrade;
  const gradingCompany = normalizeGradedField(card.gradingCompany) || inferGradingCompany(grade);
  const certificationNumber = normalizeGradedField(card.certificationNumber);
  const isAuto = card.candidateAutoHint;
  const isRookie = card.candidateRookieFlag;
  const variantLabel = card.candidateVariantLabel && card.candidateVariantLabel !== "Base" ? card.candidateVariantLabel : null;
  const isRatedRookie = variantLabel === "Rated Rookie";
  const rookieLabel = isRatedRookie ? "Rated Rookie" : isRookie ? "Rookie" : null;
  const serial = card.serialNumber;
  const printRun = card.printRun;
  const isGraded =
    card.candidateCondition === "graded" ||
    card.gradedFlag ||
    Boolean(gradingCompany || certificationNumber || (grade && !isRawGradeValue(grade)));
  const sport = inferSport(setName, card);
  const brand = inferBrand(setName);
  const condition = isGraded
    ? [gradingCompany, grade].filter(Boolean).join(" ") || grade || "Graded"
    : "Raw / Near Mint-Mint";
  const price = card.recommendedPrice;
  const notes = card.notes;
  const yearStr = year ? String(year) : null;
  const yearPrefix = yearStr && setName && setName.startsWith(yearStr) ? null : yearStr;

  const structured = [
    `${yearPrefix || ""} ${setName || ""} ${player || ""} ${cardNum ? `#${cardNum}` : ""}`.trim(),
    parallel ? `Parallel/Variety: ${parallel}` : null,
    variantLabel && !isRatedRookie ? `Insert: ${variantLabel}` : null,
    isAuto ? "Autographed" : null,
    rookieLabel ? rookieLabel : null,
    serial ? `Serial Numbered: ${serial}` : null,
    printRun ? `Print Run: ${printRun}` : null,
    gradingCompany ? `Professional Grader: ${gradingCompany}` : null,
    `Condition: ${condition}`,
    certificationNumber ? `Certification Number: ${certificationNumber}` : null,
    sport ? `Sport: ${sport}` : null,
    brand ? `Manufacturer: ${brand}` : null,
    notes ? `Notes: ${notes}` : null,
    "",
    "This card is being sold as listed. Please review images for exact condition.",
  ]
    .filter(Boolean)
    .join("\n");

  if (!process.env.OPENAI_API_KEY) return structured;

  try {
    const prompt = [
      "Generate a clean, informative eBay listing description for a sports trading card.",
      sport === "Trading Cards"
        ? "Generate a clean, informative eBay listing description for a trading card."
        : sport === "Wrestling"
          ? "Generate a clean, informative eBay listing description for a wrestling trading card."
          : "Generate a clean, informative eBay listing description for a sports trading card.",
      "Include the card identification, condition, and key selling points in plain text paragraphs.",
      "Do not use markdown or HTML. Do not include price, dollar amounts, or any pricing information anywhere in the description. The seller sets the price separately.",
      "Use a professional, helpful tone. Keep it concise (3-5 short paragraphs).",
      "End with a standard message about reviewing photos and asking questions before purchasing.",
      "",
      `Card: ${year || ""} ${setName || ""} ${player || ""} ${cardNum ? `#${cardNum}` : ""}`,
      parallel ? `Parallel: ${parallel}` : null,
      variantLabel && !isRatedRookie ? `Insert: ${variantLabel}` : null,
      isAuto ? "Autographed card" : null,
      rookieLabel ? `${rookieLabel} card` : null,
      serial ? `Serial #: ${serial}` : null,
      printRun ? `Print run: ${printRun}` : null,
      gradingCompany ? `Professional grader: ${gradingCompany}` : null,
      `Condition: ${condition}`,
      certificationNumber ? `Certification #: ${certificationNumber}` : null,
      sport ? `Sport: ${sport}` : null,
      brand ? `Brand: ${brand}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: "You generate concise, accurate eBay listing descriptions for trading cards. Output plain text only. No markdown or HTML. 3-5 short paragraphs. Never include price, dollar amounts, or any pricing information.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        text: { format: { type: "text" } },
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error?.message || `HTTP ${response.status}`);
    }

    const text =
      payload?.output_text ||
      payload?.output?.[0]?.content?.[0]?.text ||
      payload?.choices?.[0]?.message?.content;

    if (text && typeof text === "string" && text.trim()) {
      return text.trim();
    }

    return structured;
  } catch {
    return structured;
  }
}

function inferLeague(sport) {
  if (!sport) return null;
  const map = {
    Football: "National Football League (NFL)",
    Baseball: "Major League Baseball (MLB)",
    Basketball: "National Basketball Association (NBA)",
    Hockey: "National Hockey League (NHL)",
    Soccer: "Major League Soccer (MLS)",
    MMA: "UFC",
    Wrestling: "WWE",
  };
  return map[sport] || null;
}

function sanitizeParallel(value) {
  if (!value) return null;
  let s = String(value)
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > 65) s = s.slice(0, 62).trim() + "...";
  return s || null;
}

function normalizeGradedField(value) {
  const raw = String(value || "").trim();
  return raw || null;
}

function isRawGradeValue(value = "") {
  return ["Near Mint or Better", "Excellent", "Very Good", "Poor"].includes(String(value || "").trim());
}

function inferGradingCompany(value = "") {
  const raw = String(value || "").trim();
  const match = /^(PSA|BGS|SGC|CGC|CSG|BVG|BCCG|HGA)\b/i.exec(raw);
  return match ? match[1].toUpperCase() : null;
}

function buildItemSpecifics(card) {
  const year = card.candidateYear || card.year;
  const setName = card.candidateSetName || card.setName;
  const player = card.candidatePlayer || card.playerName;
  const cardNum = card.candidateCardNumber || card.cardNumber;
  const rawParallel = card.candidateParallel && card.candidateParallel !== "Base" ? card.candidateParallel : null;
  const parallel = sanitizeParallel(rawParallel);
  const grade = card.candidateGrade;
  const gradingCompany = normalizeGradedField(card.gradingCompany) || inferGradingCompany(grade);
  const certificationNumber = normalizeGradedField(card.certificationNumber);
  const isAuto = card.candidateAutoHint;
  const isRookie = card.candidateRookieFlag;
  const rookieLabel = card.candidateVariantLabel?.includes("Rated Rookie") ? "Rated Rookie" : isRookie ? "Yes" : null;
  const serial = card.serialNumber;
  const printRun = card.printRun;
  const sport = inferSport(setName, card);
  const rawBrand = card.candidateBrand;
  const brand = rawBrand && rawBrand !== "None" ? rawBrand : inferBrand(setName);
  const condition = card.candidateCondition || "raw";
  const isGraded =
    card.candidateCondition === "graded" ||
    card.gradedFlag ||
    Boolean(gradingCompany || certificationNumber || (grade && !isRawGradeValue(grade)));
  const team = card.candidateTeam || card.team;
  const league = card.candidateLeague || inferLeague(sport);
  const isThick = card.isThick || card.isThickCard;
  const thickLabel = isThick ? "20 Pt." : "Standard";
  const tradingCardKind = sport === "Trading Cards" ? inferTradingCardKind(setName, card) : null;
  const isNonSportKind = tradingCardKind === "non_sport";
  // Same condition the Type field below uses to pick "CCG Individual Card":
  // an explicit "tcg" keyword match, or an isTcgImport card whose kind is
  // merely ambiguous (not explicitly "non_sport"). Shared so Game and Type
  // never disagree — Type saying CCG with no Game value was the same
  // missing-required-field bug just on the other category's aspect.
  const isCcgKind = sport === "Trading Cards" && !isNonSportKind && (tradingCardKind === "tcg" || card.isTcgImport);
  const tcgGame =
    isCcgKind
      ? (() => {
          // brand included alongside title/set/player/notes — confirmed live
          // (2026-07-15) on a Yu-Gi-Oh card ("Galaxy-Eyes Full Armor Photon
          // Dragon #RA01-EN037") whose card/set name never mentions the game
          // at all (normal for Yu-Gi-Oh — unlike Pokémon/MTG, set names are
          // just set codes), but whose Manufacturer/brand had already
          // correctly resolved to "Yu-Gi-Oh" via inferBrand — that signal
          // just wasn't part of this haystack. setName was ALSO empty on
          // that card, so the fallback below produced null too: a real 400
          // (errorId 25002, "The item specific Game is missing").
          const haystack = String(
            [setName, player, card.ebayTitle, card.notes, brand].filter(Boolean).join(" "),
          ).toLowerCase();
          if (/\b(pokemon|pok[eé]mon)\b/.test(haystack)) return "Pokémon TCG";
          if (/\b(magic|mtg)\b/.test(haystack)) return "Magic: The Gathering";
          // Hyphenated ("Yu-Gi-Oh") is the standard brand spelling and is how
          // inferBrand normalizes it — the old pattern only matched "yugioh"
          // (no separator) or "yu gi oh" (space-separated), missing the most
          // common real-world form entirely.
          if (/\byu[\s-]?gi[\s-]?oh\b/.test(haystack)) return "Yu-Gi-Oh!";
          if (/\blorcana\b/.test(haystack)) return "Disney Lorcana";
          if (/\bone piece\b/.test(haystack)) return "One Piece CCG";
          if (/\bdigimon\b/.test(haystack)) return "Digimon Card Game";
          // eBay requires a Game value for CCG Individual Card listings —
          // fall back to the detected set name rather than omitting the
          // field for a game not in the list above (confirmed live: an
          // analogous missing Franchise value on the non-sport side was a
          // hard 400, errorId 25002).
          return setName || brand || null;
        })()
      : null;
  const nonSportFranchise =
    isNonSportKind
      ? (() => {
          const haystack = String([setName, player, card.ebayTitle, card.notes].filter(Boolean).join(" ")).toLowerCase();
          if (/\bstar wars\b/.test(haystack)) return "Star Wars";
          if (/\bmarvel\b/.test(haystack)) return "Marvel";
          if (/\bdc\b/.test(haystack)) return "DC";
          if (/\bgarbage pail\b/.test(haystack)) return "Garbage Pail Kids";
          // eBay requires Franchise for Non-Sport Trading Card Singles —
          // confirmed live via a real 400 (errorId 25002, "The item specific
          // Franchise is missing") on a Garbage Pail Kids card that fell
          // through every explicit keyword above. Fall back to the detected
          // set name rather than leaving the field out entirely.
          return setName || null;
        })()
      : null;

  const specifics = {};

  // Core identity fields always get a row — even when OCR/matching came up
  // empty — so the editable specifics table (see renderEbaySpecifics in
  // public/app.js) always has a place to fill them in by hand. The
  // genuinely-conditional fields further below (Rookie, Serial, Graded,
  // etc.) are left conditional since most cards legitimately don't have
  // them, but these identity fields are ones every card should carry.
  const isTradingCardSport = sport === "Trading Cards";
  specifics[isTradingCardSport ? "Card Name" : "Player/Athlete"] = [player || ""];
  if (!isTradingCardSport) specifics.Sport = [sport || ""];
  if (!isTradingCardSport) specifics.League = [league || ""];
  specifics.Year = [year ? String(year) : ""];
  specifics.Manufacturer = [brand || ""];
  specifics.Set = [setName || ""];
  specifics["Card Number"] = [cardNum || ""];
  specifics["Parallel/Variety"] = [parallel && parallel !== "None" ? parallel : ""];
  if (!isTradingCardSport) specifics.Team = [team || ""];
  if (tcgGame) specifics.Game = [tcgGame];
  if (nonSportFranchise) specifics.Franchise = [nonSportFranchise];
  specifics.Autographed = isAuto ? ["Yes"] : ["No"];
  if (rookieLabel) specifics.Rookie = [rookieLabel];
  if (serial) specifics["Serial Number"] = [serial];
  if (printRun) specifics["Print Run"] = [String(printRun)];
  if (isGraded) specifics.Graded = ["Yes"];
  if (gradingCompany) specifics["Professional Grader"] = [gradingCompany];
  if (grade) specifics.Grade = [grade];
  if (certificationNumber) specifics["Certification Number"] = [certificationNumber];

  specifics.Type = [
    sport === "Trading Cards"
      ? isCcgKind
        ? "CCG Individual Card"
        : "Non-Sport Trading Card"
      : "Sports Trading Card",
  ];
  specifics["Card Size"] = ["Standard"];
  specifics["Card Thickness"] = [thickLabel];
  specifics.Material = ["Card Stock"];
  specifics["Original/Licensed Reprint"] = ["Original"];
  specifics.Vintage = ["No"];
  specifics.Customized = ["No"];
  specifics.Language = ["English"];

  const features = [];
  if (isRookie) features.push("Rookie");
  if (parallel) features.push(parallel);
  if (isAuto) features.push("Autographed");
  if (features.length) specifics.Features = features;

  // Applied last so a reviewer can correct anything above — including the
  // otherwise-hardcoded fields (Type, Card Size, Material, Vintage, etc.)
  // that aren't derived from OCR at all — without needing dedicated
  // per-field UI/backend plumbing for every possible eBay item specific.
  // Empty/whitespace-only values are treated as "no override" rather than
  // clearing the specific, so a reviewer can revert to the auto-computed
  // value by blanking the input.
  const overrides = card.ebaySpecificsOverrides || {};
  for (const [key, rawValue] of Object.entries(overrides)) {
    const value = String(rawValue ?? "").trim();
    if (value) specifics[key] = [value];
  }

  return specifics;
}

// Core identity fields in buildItemSpecifics() are always present, even when
// empty, so the editable preview table always shows a fillable row. Real eBay
// submissions must not include blank aspect values though, so this strips any
// specific down to only its non-empty values (or drops it entirely) right
// before the two real-submission call sites (createInventoryItem,
// createLiveOffers). buildItemSpecificsForCard (the /ebay-preview wrapper)
// intentionally skips this so the frontend still sees the empty rows.
export function stripEmptySpecifics(specifics) {
  const result = {};
  for (const [key, values] of Object.entries(specifics)) {
    const filtered = (Array.isArray(values) ? values : [values]).filter((v) => String(v ?? "").trim());
    if (filtered.length) result[key] = filtered;
  }
  return result;
}

function buildDescription(card) {
  return [
    buildEBayTitle(card),
    card.candidateParallel ? `Parallel: ${card.candidateParallel}` : null,
    card.candidateGrade ? `Grade: ${card.candidateGrade}` : null,
    card.notes ? `Notes: ${card.notes}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// eBay's real "Card Condition" descriptor values for ungraded Sports Trading
// Card Singles (category 261328) — confirmed live via GET
// /sell/metadata/v1/marketplace/EBAY_US/get_item_condition_policies
// (descriptor id 40001, required whenever the top-level condition maps to
// "Ungraded"). These are the exact same 4 labels already offered in the
// review panel's condition dropdown for non-graded cards (public/index.html
// #reviewGrade / rawConditions in buildReviewPatch, src/app.js) — before
// this, that selection was captured but never actually reached the eBay
// listing: every raw card was hardcoded to "Near mint or better" (400010)
// regardless of what a reviewer picked, which meant a genuinely worn
// vintage card still got listed as if it were near mint.
const RAW_CONDITION_DESCRIPTOR_VALUE_IDS = {
  "near mint or better": "400010",
  excellent: "400011",
  "very good": "400012",
  poor: "400013",
};

// Confirmed live via eBay's Sell Metadata API (get_item_condition_policies)
// after a real 400 rejection ("Condition descriptor value 400011 is not
// valid for condition descriptor 40001") on a raw Magic: The Gathering
// card: CCG Individual Cards (183454) uses ENTIRELY DIFFERENT value IDs
// for descriptor 40001 than Sports (261328) and Non-Sport (183050), which
// share the table above. Only "Near mint or better" (400010) happens to
// be the same ID across all three categories.
const RAW_CONDITION_DESCRIPTOR_VALUE_IDS_TCG = {
  "near mint or better": "400010",
  excellent: "400015",
  "very good": "400016",
  poor: "400017",
};

// Coarser top-level Inventory API condition enum, kept in the same
// increasing-wear order as the descriptor above so the two fields never
// contradict each other on the listing.
// For a raw (non-graded) card, candidateGrade holds the reviewer's selected
// condition label. Defaults to "near mint or better" only when nothing
// recognizable was ever selected, matching the previous hardcoded behavior.
function normalizeRawCondition(card) {
  const normalized = String(card.candidateGrade || "").trim().toLowerCase();
  return RAW_CONDITION_DESCRIPTOR_VALUE_IDS[normalized] ? normalized : "near mint or better";
}

// categoryId here must be the SAME resolved category the listing is
// actually being created under (resolveCategoryIdForCard's result) — using
// the wrong table for the category is exactly what produced the live 400.
export function resolveRawConditionDescriptorValueId(card, categoryId) {
  const config = getConfig();
  const label = normalizeRawCondition(card);
  const table =
    String(categoryId) === String(config.tradingCardGameCategoryId)
      ? RAW_CONDITION_DESCRIPTOR_VALUE_IDS_TCG
      : RAW_CONDITION_DESCRIPTOR_VALUE_IDS;
  return table[label];
}

// Confirmed directly against eBay's own docs after a real 400 rejection
// ("Condition descriptor 40001 is not valid for condition
// INVALID_CONDITION"): the Sports Trading Card Singles category (261328)
// accepts exactly two top-level condition values, full stop — LIKE_NEW
// (Graded, condition ID 2750) or USED_VERY_GOOD (Ungraded, condition ID
// 4000). No other condition enum is valid for this category as of eBay's
// Oct 2023 trading-card policy change. The actual physical grade (Near
// Mint/Excellent/Very Good/Poor) the reviewer picks belongs ONLY in the
// condition descriptor (40001, see RAW_CONDITION_DESCRIPTOR_VALUE_IDS
// below) — varying the top-level condition by that same selection, as this
// used to do, is exactly what produced the rejection.
export function mapCondition(card) {
  if (card.candidateCondition === "graded") return "LIKE_NEW";
  return "USED_VERY_GOOD";
}

function hasEbayUserToken() {
  return Boolean(getConfig().userAccessToken);
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function xmlTagValue(xml, tagName) {
  const match = String(xml || "").match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, "i"));
  return match ? decodeXmlEntities(match[1].trim()) : null;
}

export function xmlTagValues(xml, tagName) {
  return [...String(xml || "").matchAll(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, "gi"))]
    .map((match) => decodeXmlEntities(match[1].trim()));
}

function parseTradingPrice(itemXml) {
  const currentPriceBlock = itemXml.match(/<CurrentPrice\b[^>]*currencyID="([^"]+)"[^>]*>([\s\S]*?)<\/CurrentPrice>/i);
  if (currentPriceBlock) {
    return toMoneyValue({ currency: currentPriceBlock[1], value: currentPriceBlock[2] });
  }
  const buyItNowBlock = itemXml.match(/<BuyItNowPrice\b[^>]*currencyID="([^"]+)"[^>]*>([\s\S]*?)<\/BuyItNowPrice>/i);
  if (buyItNowBlock) {
    return toMoneyValue({ currency: buyItNowBlock[1], value: buyItNowBlock[2] });
  }
  const startPriceBlock = itemXml.match(/<StartPrice\b[^>]*currencyID="([^"]+)"[^>]*>([\s\S]*?)<\/StartPrice>/i);
  if (startPriceBlock) {
    return toMoneyValue({ currency: startPriceBlock[1], value: startPriceBlock[2] });
  }
  return null;
}

function normalizeTradingListingType(value) {
  const raw = String(value || "").trim();
  if (/auction|chinese/i.test(raw)) return "AUCTION";
  return "FIXED_PRICE";
}

// Confirmed live: the Trading API reports an expired/invalid access token as
// HTTP 200 with Ack=Failure and a message like "Auth token is hard expired,
// User needs to generate a new token for this application." — NOT an HTTP
// 401 the way the REST API does. The old response.status === 401 check
// never caught this at all, so a stale-but-refreshable access token just
// threw immediately instead of refreshing and retrying once.
export const TRADING_AUTH_FAILURE_PATTERN = /hard expired|invalid access token|expired iaf token|generate a new token/i;

async function requestTradingEbay(callName, xmlBody, { retryOnExpiredToken = true } = {}) {
  const config = getConfig();
  const url = `${config.baseUrl}/ws/api.dll`;
  const headers = {
    "X-EBAY-API-CALL-NAME": callName,
    "X-EBAY-API-COMPATIBILITY-LEVEL": "1455",
    "X-EBAY-API-SITEID": "0",
    "X-EBAY-API-IAF-TOKEN": config.userAccessToken,
    "Content-Type": "text/xml",
    Accept: "text/xml",
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: xmlBody,
  });
  const text = await response.text();
  const ack = xmlTagValue(text, "Ack");
  const isAuthFailure = response.status === 401 || (ack === "Failure" && TRADING_AUTH_FAILURE_PATTERN.test(text));

  if (isAuthFailure && retryOnExpiredToken) {
    const hasRefreshToken = Boolean(runtimeOverrides.refreshToken || process.env.EBAY_REFRESH_TOKEN);
    if (hasRefreshToken) {
      await refreshEbayToken();
      return requestTradingEbay(callName, xmlBody, { retryOnExpiredToken: false });
    }
  }

  if (!response.ok || (ack && !/success|warning/i.test(ack))) {
    const longMessages = xmlTagValues(text, "LongMessage");
    const shortMessages = xmlTagValues(text, "ShortMessage");
    const message =
      [...longMessages, ...shortMessages].filter(Boolean).join("; ") ||
      text ||
      `HTTP ${response.status}`;
    throw new Error(`eBay ${callName} failed (${response.status}): ${message}`);
  }

  return text;
}

async function reviseTradingListingPrice({
  listingId,
  sku = null,
  price,
  format = "FIXED_PRICE",
} = {}) {
  const numericPrice = Number(price);
  if (!listingId) throw new Error("Trading update requires a listing ID");
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
    throw new Error("Price must be greater than 0");
  }

  if (String(format || "").toUpperCase() === "AUCTION") {
    const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <Item>
    <ItemID>${xmlEscape(listingId)}</ItemID>
    <StartPrice currencyID="USD">${xmlEscape(numericPrice.toFixed(2))}</StartPrice>
  </Item>
</ReviseItemRequest>`;
    await requestTradingEbay("ReviseItem", xmlBody);
    return;
  }

  const skuNode = sku ? `<SKU>${xmlEscape(sku)}</SKU>` : "";
  const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <InventoryStatus>
    <ItemID>${xmlEscape(listingId)}</ItemID>
    ${skuNode}
    <StartPrice>${xmlEscape(numericPrice.toFixed(2))}</StartPrice>
  </InventoryStatus>
</ReviseInventoryStatusRequest>`;
  await requestTradingEbay("ReviseInventoryStatus", xmlBody);

  // ReviseInventoryStatus is a narrow, price/quantity-only call — it can't
  // touch Best Offer terms, so without this the auto-accept/decline
  // thresholds set at publish time would silently fossilize at the
  // original price forever, drifting further out of sync with every
  // reprice that takes this fast path. Refresh them from the new price via
  // a follow-up ReviseItem (same Item.ListingDetails placement confirmed
  // live 2026-07-09 — see computeBestOfferThresholds). Best-effort: a
  // failure here (e.g. the listing is in an active sale, which blocks any
  // revision) shouldn't fail the price update that was actually requested.
  const thresholds = computeBestOfferThresholds(numericPrice);
  if (thresholds) {
    try {
      await requestTradingEbay("ReviseItem", `<?xml version="1.0" encoding="utf-8"?>
<ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <Item>
    <ItemID>${xmlEscape(listingId)}</ItemID>
    <BestOfferDetails>
      <BestOfferEnabled>true</BestOfferEnabled>
    </BestOfferDetails>
    <ListingDetails>
      <BestOfferAutoAcceptPrice currencyID="USD">${xmlEscape(thresholds.autoAcceptPrice.toFixed(2))}</BestOfferAutoAcceptPrice>
      <MinimumBestOfferPrice currencyID="USD">${xmlEscape(thresholds.autoDeclinePrice.toFixed(2))}</MinimumBestOfferPrice>
    </ListingDetails>
  </Item>
</ReviseItemRequest>`);
    } catch (error) {
      console.warn(`Best Offer threshold refresh failed for listing ${listingId}:`, error.message);
    }
  }
}

async function requestEbay(pathname, { method = "GET", body } = {}) {
  const config = getConfig();
  const url = `${config.baseUrl}${pathname}`;
  const headers = {
    Authorization: `Bearer ${config.userAccessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Content-Language": "en-US",
    "Accept-Language": "en-US",
    "X-EBAY-C-MARKETPLACE-ID": config.marketplaceId || "EBAY_US",
  };

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (response.status === 401) {
    const hasRefreshToken = Boolean(runtimeOverrides.refreshToken || process.env.EBAY_REFRESH_TOKEN);
    if (hasRefreshToken) {
      try {
        await refreshEbayToken();
        return requestEbay(pathname, { method, body });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(
          `eBay ${method} ${pathname} failed (401): Access token expired and refresh failed (${errorMessage}). Please re-authorize in Settings or run /api/ebay/auth-url.`,
        );
      }
    }
    throw new Error(
      `eBay ${method} ${pathname} failed (401): No access token and no refresh token configured. Please authorize via /api/ebay/auth-url.`,
    );
  }

  if (!response.ok) {
    const errors = payload?.errors || [];
    const message =
      errors.map((e) => e.message).filter(Boolean).join("; ") ||
      payload?.message ||
      text ||
      `HTTP ${response.status}`;
    const hasInsufficientPermission =
      response.status === 403 &&
      errors.some(
        (e) =>
          String(e.errorId || "") === "1100" ||
          String(e.message || "").toLowerCase().includes("insufficient") ||
          String(e.longMessage || "").toLowerCase().includes("insufficient"),
      );
    if (hasInsufficientPermission) {
      runtimeOverrides.userAccessToken = "";
      runtimeOverrides.refreshToken = "";
      saveEbayConfig().catch(() => {});
      const fulfillmentHint =
        "Access to this endpoint requires fulfillment access scope. Reauthorize using eBay with sell.fulfillment and/or sell.fulfillment.readonly enabled.";
      const detail = [message, fulfillmentHint].join(" ");
      const longMsg = errors.length
        ? `${detail} — Details: ${JSON.stringify(errors.slice(0, 3))}`
        : detail;
      throw new Error(`eBay ${method} ${pathname} failed (${response.status}): ${longMsg}`);
    }
    const longMsg = errors.length
      ? `${message} — Details: ${JSON.stringify(errors.slice(0, 3))}`
      : message;
    throw new Error(`eBay ${method} ${pathname} failed (${response.status}): ${longMsg}`);
  }

  return payload;
}

export async function fetchEbayFulfillmentOrders({
  startDate = null,
  endDate = null,
  days = 180,
  pageSize = 100,
  maxPages = 5,
} = {}) {
  const safePageSize = toPositiveInt(pageSize, 100);
  const safeMaxPages = toPositiveInt(maxPages, 5);
  const range = normalizeOrderDateRange({ startDate, endDate, days });
  const fetchWindow = buildFulfillmentOrderFetchWindow(range);
  const query = new URLSearchParams({
    limit: String(Math.max(1, Math.min(100, safePageSize))),
    filter: `creationdate:[${fetchWindow.queryStart}..${fetchWindow.queryEnd}]`,
    sort: "-createdDate",
    fieldgroups: "EXTENDED",
  });
  let pagePath = `/sell/fulfillment/v1/order?${query.toString()}`;
  const orders = [];
  let page = 0;
  while (pagePath && page < safeMaxPages) {
    const payload = await requestEbay(pagePath);
    const rows = Array.isArray(payload.orders) ? payload.orders : [];
    orders.push(...rows);
    if (!payload.next) {
      pagePath = null;
      break;
    }
    try {
      const nextUrl = new URL(payload.next, getConfig().baseUrl);
      pagePath = `${nextUrl.pathname}${nextUrl.search}`;
    } catch {
      pagePath = null;
    }
    page += 1;
  }
  const filtered = orders.filter((order) => {
    if (!isLikelySalesOrder(order)) return false;
    if (!fetchWindow.requestedStart || !fetchWindow.requestedEnd) return true;
    const soldAt = safeDate(normalizeOrderDate(order));
    if (!soldAt) return false;
    return soldAt >= fetchWindow.requestedStart && soldAt <= fetchWindow.requestedEnd;
  });
  return { dateRange: range, totalFound: filtered.length, orders: filtered };
}

function normalizeActiveListing(offer = {}) {
  const imageUrls = [
    ...(Array.isArray(offer?.listing?.imageUrls) ? offer.listing.imageUrls : []),
    ...(Array.isArray(offer?.imageUrls) ? offer.imageUrls : []),
    ...(Array.isArray(offer?.product?.imageUrls) ? offer.product.imageUrls : []),
    ...(Array.isArray(offer?.inventoryItem?.product?.imageUrls) ? offer.inventoryItem.product.imageUrls : []),
    offer?.listing?.imageUrl,
    offer?.imageUrl,
    offer?.product?.imageUrl,
    offer?.inventoryItem?.product?.imageUrl,
    offer?.frontImageUrl,
    offer?.backImageUrl,
  ]
    .map((value) => String(value || "").trim())
    .filter((value, index, list) => value && value !== "NONE" && list.indexOf(value) === index);
  const price =
    toMoneyValue(offer?.pricingSummary?.price) ??
    toMoneyValue(offer?.pricingSummary?.auctionStartPrice) ??
    toMoneyValue(offer?.currentPrice) ??
    toMoneyValue(offer?.price) ??
    null;
  const listingUrl =
    offer?.listing?.listingWebUrl ||
    offer?.listing?.listingUrl ||
    offer?.listingUrl ||
    null;
  const listingId =
    offer?.listing?.listingId ||
    offer?.listingId ||
    extractListingIdFromUrl(listingUrl);
  const title =
    offer?.listing?.title ||
    offer?.ebayTitle ||
    offer?.title ||
    offer?.inventoryItem?.title ||
    offer?.inventoryItem?.product?.title ||
    offer?.product?.title ||
    null;
  const listedAt =
    offer?.listing?.listingStartDate ||
    offer?.listingStartDate ||
    offer?.publishedAt ||
    offer?.creationDate ||
    offer?.createdDate ||
    null;
  const quantity =
    toCountValue(offer?.availableQuantity) ??
    toCountValue(offer?.quantity) ??
    toCountValue(offer?.listing?.availableQuantity) ??
    null;
  const soldQuantity =
    toCountValue(offer?.listing?.soldQuantity) ??
    toCountValue(offer?.soldQuantity) ??
    null;
  const watchCount =
    toCountValue(offer?.listing?.watchCount) ??
    toCountValue(offer?.watchCount) ??
    null;
  const impressionCount =
    toCountValue(offer?.listing?.impressionCount) ??
    toCountValue(offer?.impressionCount) ??
    null;

  return {
    offerId: offer?.offerId || offer?.ebayOfferId || offer?.id || null,
    sku: offer?.sku || null,
    marketplaceId: offer?.marketplaceId || null,
    format: String(offer?.format || "FIXED_PRICE").toUpperCase(),
    status: String(
      offer?.status || offer?.listing?.listingStatus || offer?.listingStatus || "UNKNOWN",
    ).toUpperCase(),
    listingId,
    listingUrl: listingUrl || (listingId ? `https://www.ebay.com/itm/${listingId}` : null),
    title,
    imageUrl: imageUrls[0] || null,
    imageUrls,
    currentPrice: price,
    listedAt,
    quantity,
    soldQuantity,
    watchCount,
    impressionCount,
    bestOfferEnabled: Boolean(
      offer?.listingPolicies?.bestOfferTerms?.bestOfferEnabled ||
      offer?.bestOfferTerms?.bestOfferEnabled,
    ),
  };
}

function activeListingIdentityKey(offer = {}) {
  return offer?.listingId || extractListingIdFromUrl(offer?.listingUrl) || offer?.sku || offer?.offerId || null;
}

function isUsableActiveListing(offer = {}) {
  if (["ENDED", "DELETED", "UNPUBLISHED", "ARCHIVED", "FAILED"].includes(offer?.status)) {
    return false;
  }
  if (String(offer?.format || "").toUpperCase() === "FIXED_PRICE") {
    const price = Number(offer?.currentPrice);
    const quantity = Number(offer?.quantity);
    if (!Number.isFinite(price) || price <= 0) return false;
    if (!Number.isFinite(quantity) || quantity <= 0) return false;
  }
  return true;
}

function mergeActiveListingRecords(primary = {}, secondary = {}) {
  const imageUrls = [
    ...(Array.isArray(primary.imageUrls) ? primary.imageUrls : []),
    ...(Array.isArray(secondary.imageUrls) ? secondary.imageUrls : []),
    primary.imageUrl,
    secondary.imageUrl,
  ]
    .map((value) => String(value || "").trim())
    .filter((value, index, list) => value && value !== "NONE" && list.indexOf(value) === index);
  return {
    ...secondary,
    ...primary,
    listedAt: primary.listedAt || secondary.listedAt || null,
    currentPrice: primary.currentPrice ?? secondary.currentPrice ?? null,
    quantity: primary.quantity ?? secondary.quantity ?? null,
    watchCount: primary.watchCount ?? secondary.watchCount ?? null,
    soldQuantity: primary.soldQuantity ?? secondary.soldQuantity ?? null,
    bestOfferEnabled: primary.bestOfferEnabled || secondary.bestOfferEnabled || false,
    title: primary.title || secondary.title || null,
    imageUrl: primary.imageUrl || secondary.imageUrl || imageUrls[0] || null,
    imageUrls,
    listingUrl: primary.listingUrl || secondary.listingUrl || null,
    listingId: primary.listingId || secondary.listingId || null,
    sku: primary.sku || secondary.sku || null,
    offerId: primary.offerId || secondary.offerId || null,
    marketplaceId: primary.marketplaceId || secondary.marketplaceId || null,
    format: primary.format || secondary.format || "FIXED_PRICE",
    status: primary.status || secondary.status || "UNKNOWN",
  };
}

async function withEbayTimeout(promise, timeoutMs, label) {
  let timeoutId = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function isEbayAuthFailure(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("auth token") ||
    message.includes("oauth") ||
    message.includes("authorize") ||
    message.includes("authorization") ||
    message.includes("expired")
  );
}

async function fetchTradingActiveListings({ pageSize = 200, maxPages = 10 } = {}) {
  if (!hasEbayUserToken()) return [];
  const safePageSize = Math.max(1, Math.min(200, toPositiveInt(pageSize, 200)));
  const safeMaxPages = toPositiveInt(maxPages, 10);
  const listings = [];
  let totalPages = 1;

  for (let pageNumber = 1; pageNumber <= safeMaxPages && pageNumber <= totalPages; pageNumber += 1) {
    const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailLevel>ReturnAll</DetailLevel>
  <ActiveList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>${xmlEscape(safePageSize)}</EntriesPerPage>
      <PageNumber>${xmlEscape(pageNumber)}</PageNumber>
    </Pagination>
  </ActiveList>
</GetMyeBaySellingRequest>`;
    const responseXml = await requestTradingEbay("GetMyeBaySelling", xmlBody);
    const activeListXml = xmlTagValue(responseXml, "ActiveList") || "";
    const totalPagesValue = Number.parseInt(xmlTagValue(activeListXml, "TotalNumberOfPages") || "1", 10);
    totalPages = Number.isFinite(totalPagesValue) && totalPagesValue > 0 ? totalPagesValue : 1;
    const itemBlocks = [...activeListXml.matchAll(/<Item>([\s\S]*?)<\/Item>/gi)];
    for (const [, itemXml] of itemBlocks) {
      const listingId = xmlTagValue(itemXml, "ItemID");
      if (!listingId) continue;
      const listingUrl = xmlTagValue(itemXml, "ViewItemURL") || `https://www.ebay.com/itm/${listingId}`;
      listings.push({
        offerId: null,
        sku: xmlTagValue(itemXml, "SKU"),
        marketplaceId: getConfig().marketplaceId || "EBAY_US",
        format: normalizeTradingListingType(xmlTagValue(itemXml, "ListingType")),
        status: "PUBLISHED",
        listingId,
        listingUrl,
        title: xmlTagValue(itemXml, "Title"),
        imageUrl: xmlTagValue(itemXml, "PictureURL") || xmlTagValue(itemXml, "GalleryURL") || null,
        imageUrls: [xmlTagValue(itemXml, "PictureURL") || xmlTagValue(itemXml, "GalleryURL") || null]
          .filter(Boolean),
        currentPrice: parseTradingPrice(itemXml),
        listedAt: xmlTagValue(itemXml, "StartTime"),
        quantity:
          toCountValue(xmlTagValue(itemXml, "QuantityAvailable")) ??
          toCountValue(xmlTagValue(itemXml, "Quantity")),
        soldQuantity: toCountValue(xmlTagValue(itemXml, "QuantitySold")),
        watchCount: toCountValue(xmlTagValue(itemXml, "WatchCount")),
        impressionCount: null,
        bestOfferEnabled: String(xmlTagValue(itemXml, "BestOfferEnabled") || "").toLowerCase() === "true",
      });
    }
  }

  return listings;
}

export async function fetchEbayActiveListings({
  offers = [],
  marketplaceId = null,
  pageSize = 100,
  maxPages = 5,
  live = true,
} = {}) {
  await ebayConfigReady.catch(() => {});
  const safePageSize = Math.max(1, Math.min(200, toPositiveInt(pageSize, 100)));
  const safeMaxPages = toPositiveInt(maxPages, 5);
  const sliceLimit = safePageSize * safeMaxPages;
  const trackedOffers = (Array.isArray(offers) ? offers : [])
    .filter((offer) =>
      Boolean(
        offer?.ebayOfferId ||
        offer?.offerId ||
        offer?.sku ||
        offer?.listingUrl ||
        offer?.listingId,
      ),
    )
    .slice(0, sliceLimit);
  const normalizedTrackedOffers = trackedOffers.map(normalizeActiveListing);
  const trackedByListingId = new Map();
  const trackedByUrlId = new Map();
  const trackedBySku = new Map();
  for (const offer of normalizedTrackedOffers) {
    if (offer?.listingId) trackedByListingId.set(String(offer.listingId), offer);
    const urlId = extractListingIdFromUrl(offer?.listingUrl);
    if (urlId) trackedByUrlId.set(String(urlId), offer);
    if (offer?.sku) trackedBySku.set(String(offer.sku), offer);
  }

  if (!live || !hasEbayUserToken()) {
    return normalizedTrackedOffers
      .filter((offer) => !["FAILED", "DELETED"].includes(offer.status));
  }

  const sourceTimeoutMs = Math.max(
    3000,
    Math.min(30000, Number.parseInt(process.env.EBAY_ACTIVE_SOURCE_TIMEOUT_MS || "30000", 10) || 30000),
  );
  let tradingListings = [];
  try {
    tradingListings = await withEbayTimeout(
      fetchTradingActiveListings({
        pageSize: safePageSize,
        maxPages: safeMaxPages,
      }),
      sourceTimeoutMs,
      "Trading active listings",
    );
  } catch (error) {
    if (isEbayAuthFailure(error)) throw error;
    console.warn("Trading active listings unavailable:", error.message);
    tradingListings = [];
  }

  const selectedMarketplaceId = marketplaceId || getConfig().marketplaceId || "EBAY_US";
  const inventoryItems = [];
  let offset = 0;
  for (let page = 0; page < safeMaxPages; page += 1) {
    let payload = null;
    try {
      payload = await withEbayTimeout(
        requestEbay(
          `/sell/inventory/v1/inventory_item?${new URLSearchParams({
            limit: String(safePageSize),
            offset: String(offset),
          }).toString()}`,
        ),
        sourceTimeoutMs,
        "Inventory active listings",
      );
    } catch (error) {
      if (isEbayAuthFailure(error)) throw error;
      console.warn("Inventory active listings unavailable:", error.message);
      break;
    }
    const rows = Array.isArray(payload?.inventoryItems) ? payload.inventoryItems : [];
    inventoryItems.push(...rows);
    if (!rows.length || rows.length < safePageSize) break;
    offset += rows.length;
  }
  const hydrated = inventoryItems
    .slice(0, sliceLimit)
    .map((item) => {
      const sku = item?.sku || null;
      if (!sku) return null;
      const tracked = trackedBySku.get(String(sku));
      if (!tracked) return null;
      return normalizeActiveListing({
        ...item,
        ...tracked,
        sku,
        status: tracked?.status || item?.status || "PUBLISHED",
      });
    })
    .filter(Boolean);

  const hydratedByListingId = new Map();
  const hydratedByUrlId = new Map();
  const hydratedBySku = new Map();
  for (const offer of hydrated) {
    if (offer?.listingId) hydratedByListingId.set(String(offer.listingId), offer);
    const urlId = extractListingIdFromUrl(offer?.listingUrl);
    if (urlId) hydratedByUrlId.set(String(urlId), offer);
    if (offer?.sku) hydratedBySku.set(String(offer.sku), offer);
  }

  const canonicalLiveOffers = [...tradingListings, ...hydrated];
  const byIdentity = new Map();
  for (const offer of canonicalLiveOffers) {
    const key = activeListingIdentityKey(offer);
    if (!key) continue;
    const liveMatch =
      (offer?.listingId ? hydratedByListingId.get(String(offer.listingId)) : null) ||
      (offer?.listingUrl ? hydratedByUrlId.get(String(extractListingIdFromUrl(offer.listingUrl) || "")) : null) ||
      (!offer?.listingId && offer?.sku ? hydratedBySku.get(String(offer.sku)) : null) ||
      null;
    const liveMergedOffer = liveMatch ? mergeActiveListingRecords(offer, liveMatch) : offer;
    const trackedMatch =
      (liveMergedOffer?.listingId ? trackedByListingId.get(String(liveMergedOffer.listingId)) : null) ||
      (liveMergedOffer?.listingUrl ? trackedByUrlId.get(String(extractListingIdFromUrl(liveMergedOffer.listingUrl) || "")) : null) ||
      (!liveMergedOffer?.listingId && liveMergedOffer?.sku ? trackedBySku.get(String(liveMergedOffer.sku)) : null) ||
      null;
    const mergedOffer = trackedMatch ? mergeActiveListingRecords(liveMergedOffer, trackedMatch) : liveMergedOffer;
    if (!byIdentity.has(key)) {
      byIdentity.set(key, mergedOffer);
      continue;
      }
      const existing = byIdentity.get(key);
      byIdentity.set(key, mergeActiveListingRecords(existing, mergedOffer));
    }

  return [...byIdentity.values()].filter(isUsableActiveListing);
}

export async function createInventoryItem(card) {
  const config = getConfig();
  const sku = card.sku;
  const title = card.ebayTitle || buildEBayTitle(card);
  const description = card.ebayDescription || await buildEBayDescription(card);
  const specifics = stripEmptySpecifics(buildItemSpecifics(card));
  const isGraded = card.candidateCondition === "graded" || card.gradedFlag;
  const resolvedCategoryId = resolveCategoryIdForCard(card);
  const conditionDescriptors = isGraded
    ? buildConditionDescriptors(card, {
        categoryId: resolvedCategoryId,
        sportsCategoryId: config.categoryId
      })
    : [
        {
          name: "40001",
          values: [resolveRawConditionDescriptorValueId(card, resolvedCategoryId)],
        },
      ];
  const body = {
    condition: mapCondition(card),
    conditionDescriptors,
    availability: {
      shipToLocationAvailability: {
        quantity: 1,
      },
    },
    product: {
      title,
      description,
      aspects: specifics,
      imageUrls: [card.frontImageUrl, card.backImageUrl].filter((u) => u && u !== "NONE"),
    },
    packageWeightAndSize: {
      dimensions: {
        height: 1,
        length: 11,
        width: 6,
        unit: "INCH",
      },
      packageType: "PACKAGE_THICK_ENVELOPE",
      weight: {
        value: "1",
        unit: "OUNCE",
      },
    },
  };
  const itemResponse = await requestEbay(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
    method: "PUT",
    body,
  });
  console.log("=== INVENTORY_ITEM CREATED ===", sku, JSON.stringify(itemResponse).slice(0, 200));
  return {
    sku,
    marketplaceId: config.marketplaceId,
    title,
  };
}

async function createLiveOffers(cardItems) {
  const config = getConfig();

  // Create/update inventory items first
  for (const card of cardItems) {
    await createInventoryItem(card);
  }

  const requests = await Promise.all(cardItems.map(async (card) => {
    const listingConfig = getEbayListingConfig(card, {});
    const cardPrice = getCardPrice(card);
    const pricingSummary = buildEbayPricingSummary({
      listingConfig,
      cardPrice,
    });
    const title = card.ebayTitle || buildEBayTitle(card);
    const description = card.ebayDescription || await buildEBayDescription(card);
    const request = {
      sku: card.sku,
      marketplaceId: config.marketplaceId,
      format: listingConfig.format,
      categoryId: resolveCategoryIdForCard(card),
      merchantLocationKey: config.merchantLocationKey,
      countryCode: "US",
      listingDescription: description,
      listingPolicies: {
        paymentPolicyId: config.paymentPolicyId,
        fulfillmentPolicyId: getFulfillmentPolicyIdForCard(card),
        returnPolicyId: config.returnPolicyId,
        // bestOfferTerms lives HERE, nested under listingPolicies — not as a
        // top-level sibling field. Confirmed live (2026-07-09): a top-level
        // bestOfferTerms is silently dropped by eBay's bulk_create_offer;
        // GET on a real created offer showed it completely absent from the
        // response either way. This regression affected every offer created
        // since card_0063, all missing Best Offer despite the code always
        // intending to enable it. Best Offer is a fixed-price-only feature,
        // so auctions get no terms at all — the old top-level placement
        // meant eBay never saw them for auctions either, and starting to
        // send them now that the nesting is right could turn a formerly
        // ignored field into a real rejection.
        ...(listingConfig.format === "AUCTION"
          ? {}
          : { bestOfferTerms: normalizeBestOfferTerms({}, cardPrice) }),
      },
      includeCatalogProductDetails: false,
      pricingSummary,
      product: {
        title,
        aspects: stripEmptySpecifics(buildItemSpecifics(card)),
        imageUrls: [card.frontImageUrl, card.backImageUrl].filter((u) => u && u !== "NONE"),
      },
    };
    if (listingConfig.format === "AUCTION") {
      request.listingDuration = listingConfig.listingDuration || DEFAULT_AUCTION_DURATION;
    } else {
      request.availableQuantity = 1;
      request.quantityLimitPerBuyer = 1;
    }
    return request;
  }));

  let results;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const payload = await requestEbay("/sell/inventory/v1/bulk_create_offer", {
        method: "POST",
        body: { requests },
      });
      results = payload.responses.map((response, index) => ({
        ebayOfferId: response.offerId,
        inventoryItemId: cardItems[index].sku,
        sku: cardItems[index].sku,
        status: response.statusCode === 200 ? "created" : "failed",
        listingId: response.listingId || null,
        requestPayload: requests[index],
        rawResponse: response,
      }));
      // Check for individual "already exists" errors and retry
      const existingErrors = results.filter((r) => {
        const errs = r.rawResponse?.errors || [];
        return errs.some((e) => e.errorId === 25002);
      });
      if (existingErrors.length === 0) break;
      console.log(`=== OFFER CREATE ATTEMPT ${attempt + 1} HAD ${existingErrors.length} EXISTING OFFER ERRORS, DELETING... ===`);
      for (const r of existingErrors) {
        for (const err of (r.rawResponse?.errors || [])) {
          const offerIdParam = err.parameters?.find((p) => p.name === "offerId");
          if (offerIdParam?.value) {
            console.log("=== DELETING EXISTING OFFER ===", offerIdParam.value);
            await deleteEbayOffer(offerIdParam.value);
          }
        }
      }
      continue; // retry
    } catch (error) {
      console.log(`=== OFFER CREATE ATTEMPT ${attempt + 1} FAILED ===`, error.message.slice(0, 300));
      // Parse the error body to find existing offer IDs
      const bodyMatch = error.message.match(/\{.*\}/s);
      if (bodyMatch) {
        try {
          const errorPayload = JSON.parse(bodyMatch[0]);
          const items = errorPayload.responses || [errorPayload];
          let deletedAny = false;
          for (const item of items) {
            for (const err of (item.errors || [])) {
              const offerIdParam = err.parameters?.find((p) => p.name === "offerId");
              if (offerIdParam?.value) {
                console.log("=== DELETING EXISTING OFFER ===", offerIdParam.value);
                await deleteEbayOffer(offerIdParam.value);
                deletedAny = true;
              }
            }
          }
          if (deletedAny) continue; // retry
        } catch {
          // could not parse — throw
        }
      }
      throw error; // no recovery possible
    }
  }

  if (!results) throw new Error("Failed to create offers after 3 attempts");

  console.log("=== BULK_CREATE_OFFER RESPONSE ===", JSON.stringify(results, null, 2));

  // verify the offer was actually created
  for (const result of results) {
    if (result.ebayOfferId) {
      try {
        const verify = await requestEbay(`/sell/inventory/v1/offer/${result.ebayOfferId}`, { method: "GET" });
        console.log("=== OFFER VERIFIED ===", result.ebayOfferId, JSON.stringify(verify).slice(0, 300));
      } catch (e) {
        console.log("=== OFFER VERIFY FAILED ===", result.ebayOfferId, e.message);
      }
    }
  }

  return results;
}

async function updateLiveOfferPrices(offers) {
  const updated = [];
  for (const offer of offers) {
    const requestPayload = offer.requestPayload || {};
    const isThick = offer.isThickCard ?? false;
    const price = getCardPrice(offer);
    const listingConfig = getEbayListingConfig(offer, requestPayload);
    const listingPolicies = {
      paymentPolicyId:
        requestPayload.listingPolicies?.paymentPolicyId || getConfig().paymentPolicyId,
      fulfillmentPolicyId: getFulfillmentPolicyIdForCard({
        ...offer,
        recommendedPrice: price,
        isThickCard: isThick,
      }),
      returnPolicyId: requestPayload.listingPolicies?.returnPolicyId || getConfig().returnPolicyId,
      // Nested here, not top-level, and recomputed from the price this
      // update is pushing — see the matching comment in createLiveOffers
      // for why (auctions excluded there too).
      ...(listingConfig.format === "AUCTION"
        ? {}
        : {
            bestOfferTerms: normalizeBestOfferTerms(
              requestPayload.listingPolicies?.bestOfferTerms,
              price,
            ),
          }),
    };
    const body = {
      ...requestPayload,
      sku: offer.sku,
      marketplaceId: requestPayload.marketplaceId || getConfig().marketplaceId,
      format: listingConfig.format,
      categoryId: requestPayload.categoryId || resolveCategoryIdForCard(offer),
      merchantLocationKey: requestPayload.merchantLocationKey || getConfig().merchantLocationKey,
      listingDescription: offer.ebayDescription || requestPayload.listingDescription || "",
      listingPolicies,
      pricingSummary: buildEbayPricingSummary({
        listingConfig,
        cardPrice: price,
        existingPricing: requestPayload.pricingSummary || {},
      }),
      product: {
        title: offer.ebayTitle || requestPayload.product?.title || "",
        aspects: (offer.ebaySpecifics || requestPayload.product?.aspects || {}),
        imageUrls:
          [offer.frontImageUrl, offer.backImageUrl].filter((u) => u && u !== "NONE").length
            ? [offer.frontImageUrl, offer.backImageUrl].filter((u) => u && u !== "NONE")
            : (requestPayload.product?.imageUrls || []),
      },
    };
    if (listingConfig.format === "AUCTION") {
      delete body.availableQuantity;
      delete body.quantityLimitPerBuyer;
      body.listingDuration = listingConfig.listingDuration || DEFAULT_AUCTION_DURATION;
    } else {
      body.availableQuantity = requestPayload.availableQuantity ?? 1;
      body.quantityLimitPerBuyer = requestPayload.quantityLimitPerBuyer ?? 1;
      delete body.listingDuration;
    }

    if (offer.ebayOfferId) {
      const response = await requestEbay(
        `/sell/inventory/v1/offer/${encodeURIComponent(offer.ebayOfferId)}`,
        {
          method: "PUT",
          body,
        },
      );
      updated.push({
        ...offer,
        status: offer.status,
        syncedAt: new Date().toISOString(),
        requestPayload: body,
        rawResponse: response,
      });
      continue;
    }

    updated.push({
      ...offer,
      status: "updated",
      syncedAt: new Date().toISOString(),
      requestPayload: body,
    });
  }
  return updated;
}

function sanitizeOfferPayloadForUpdate(payload = {}) {
  return {
    sku: payload.sku,
    marketplaceId: payload.marketplaceId,
    format: payload.format,
    availableQuantity: payload.availableQuantity,
    categoryId: payload.categoryId,
    merchantLocationKey: payload.merchantLocationKey,
    listingDescription: payload.listingDescription,
    listingPolicies: payload.listingPolicies,
    pricingSummary: payload.pricingSummary,
    quantityLimitPerBuyer: payload.quantityLimitPerBuyer,
    includeCatalogProductDetails: payload.includeCatalogProductDetails,
    lotSize: payload.lotSize,
    listingDuration: payload.listingDuration,
    product: payload.product
      ? {
          title: payload.product.title,
          aspects: payload.product.aspects,
          imageUrls: payload.product.imageUrls,
        }
      : undefined,
  };
}

async function fetchOfferForListingUpdate({ offerId = null, sku = null, listingId = null } = {}) {
  if (offerId) {
    return requestEbay(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, { method: "GET" });
  }
  if (!sku) throw new Error("Listing update requires an offer ID or SKU");
  const payload = await requestEbay(
    `/sell/inventory/v1/offer?${new URLSearchParams({
      sku: String(sku),
      marketplace_id: getConfig().marketplaceId || "EBAY_US",
    }).toString()}`,
  );
  const offers = Array.isArray(payload?.offers) ? payload.offers : [];
  const match =
    offers.find((item) => String(item?.listing?.listingId || item?.listingId || "") === String(listingId || "")) ||
    offers[0];
  if (!match?.offerId) {
    throw new Error("Could not find an editable eBay offer for this listing");
  }
  return match;
}

export async function updateEbayListingPrice({
  offerId = null,
  sku = null,
  listingId = null,
  format = "FIXED_PRICE",
  price,
} = {}) {
  const numericPrice = Number(price);
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
    throw new Error("Price must be greater than 0");
  }

  if (listingId) {
    try {
      await reviseTradingListingPrice({ listingId, sku, price: numericPrice, format });
      return {
        offerId,
        sku,
        listingId,
        listingUrl: `https://www.ebay.com/itm/${listingId}`,
        price: numericPrice,
        format,
        status: "updated",
      };
    } catch (error) {
      if (!offerId && !sku) throw error;
    }
  }

  let offerPayload;
  try {
    offerPayload = await fetchOfferForListingUpdate({ offerId, sku, listingId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!listingId || !/not available|could not find/i.test(message)) throw error;
    await reviseTradingListingPrice({ listingId, sku, price: numericPrice, format });
    return {
      offerId,
      sku,
      listingId,
      listingUrl: `https://www.ebay.com/itm/${listingId}`,
      price: numericPrice,
      format,
      status: "updated",
    };
  }
  const requestPayload = sanitizeOfferPayloadForUpdate(offerPayload);
  const updated = await updateLiveOfferPrices([{
    ebayOfferId: offerPayload.offerId,
    sku: offerPayload.sku,
    requestPayload,
    ebayTitle: offerPayload.product?.title || "",
    ebayDescription: offerPayload.listingDescription || "",
    ebaySpecifics: offerPayload.product?.aspects || {},
    recommendedPrice: numericPrice,
    ebayListingFormat: offerPayload.format,
    ebayAuctionDuration: offerPayload.listingDuration,
    ebayAuctionStartPrice:
      offerPayload.format === "AUCTION"
        ? numericPrice
        : offerPayload.pricingSummary?.auctionStartPrice?.value,
    ebayAuctionReservePrice: offerPayload.pricingSummary?.auctionReservePrice?.value,
    ebayAuctionBuyItNowPrice:
      offerPayload.format === "AUCTION"
        ? offerPayload.pricingSummary?.price?.value
        : undefined,
  }]);
  const result = updated?.[0] || {};
  return {
    offerId: offerPayload.offerId,
    sku: offerPayload.sku,
    listingId: offerPayload.listing?.listingId || offerPayload.listingId || listingId || null,
    listingUrl:
      offerPayload.listing?.listingWebUrl ||
      offerPayload.listing?.listingUrl ||
      (offerPayload.listing?.listingId || offerPayload.listingId
        ? `https://www.ebay.com/itm/${offerPayload.listing?.listingId || offerPayload.listingId}`
        : null),
    price: numericPrice,
    format: offerPayload.format,
    status: result.status || offerPayload.status || "updated",
  };
}

// Ends a stale listing and immediately relists it fresh — eBay's "Sell
// Similar"-style age reset, so an old listing re-enters search as a new
// one. Two paths, matching how the listing was created (the same split the
// Best Offer backfill confirmed live):
//   - Inventory-API listings (a REST offer exists for the SKU): withdraw
//     the offer, then publish it again — eBay issues a fresh listingId.
//     Trading's Relist calls reject these outright ("Inventory-based
//     listing management is not currently supported by this tool").
//   - Everything else: Trading EndFixedPriceItem + RelistFixedPriceItem.
// Returns { oldListingId, newListingId, via }. The caller is responsible
// for updating local records to the new listingId.
export async function relistEbayListing({ listingId, sku = null } = {}) {
  if (!listingId) throw new Error("Relist requires a listing ID");

  let restOffer = null;
  if (sku) {
    const payload = await requestEbay(
      `/sell/inventory/v1/offer?${new URLSearchParams({
        sku: String(sku),
        marketplace_id: getConfig().marketplaceId || "EBAY_US",
      }).toString()}`,
    ).catch(() => null);
    const offers = Array.isArray(payload?.offers) ? payload.offers : [];
    restOffer = offers.find((o) => String(o?.listing?.listingId || "") === String(listingId)) || null;
  }

  if (restOffer?.offerId) {
    await requestEbay(`/sell/inventory/v1/offer/${encodeURIComponent(restOffer.offerId)}/withdraw`, {
      method: "POST",
    });
    const published = await requestEbay(
      `/sell/inventory/v1/offer/${encodeURIComponent(restOffer.offerId)}/publish`,
      { method: "POST" },
    );
    const newListingId = published?.listingId ? String(published.listingId) : null;
    if (!newListingId) {
      throw new Error("Relist republish returned no listing ID — the offer is now WITHDRAWN and needs a manual publish");
    }
    return { oldListingId: String(listingId), newListingId, via: "rest" };
  }

  const endXml = `<?xml version="1.0" encoding="utf-8"?>
<EndFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${xmlEscape(listingId)}</ItemID>
  <EndingReason>NotAvailable</EndingReason>
</EndFixedPriceItemRequest>`;
  await requestTradingEbay("EndFixedPriceItem", endXml);

  const relistXml = `<?xml version="1.0" encoding="utf-8"?>
<RelistFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <Item>
    <ItemID>${xmlEscape(listingId)}</ItemID>
  </Item>
</RelistFixedPriceItemRequest>`;
  const relistText = await requestTradingEbay("RelistFixedPriceItem", relistXml);
  const newListingId = xmlTagValue(relistText, "ItemID");
  if (!newListingId) {
    throw new Error("Relist succeeded ending the item but RelistFixedPriceItem returned no new ItemID — the listing is currently ENDED");
  }
  return { oldListingId: String(listingId), newListingId: String(newListingId), via: "trading" };
}

async function publishLiveOffers(offers) {
  const payload = await requestEbay("/sell/inventory/v1/bulk_publish_offer", {
    method: "POST",
    body: {
      requests: offers.map((offer) => ({
        offerId: offer.ebayOfferId,
      })),
    },
  });

  return payload.responses.map((response, index) => ({
    ...offers[index],
    status: response.statusCode === 200 ? "published" : "failed",
    listingId: response.listingId || offers[index].listingId || null,
    listingUrl: response.listingId ? `https://www.ebay.com/itm/${response.listingId}` : null,
    publishedAt: new Date().toISOString(),
    rawResponse: response,
  }));
}

export async function createDraftOffers(cardItems) {
  if (!hasLiveConfig()) {
      return cardItems.map((item) => {
        const listingConfig = getEbayListingConfig(item, {});
        const pricingSummary = buildEbayPricingSummary({
          listingConfig,
          cardPrice: getCardPrice(item),
        });
        const title = item.ebayTitle || buildEBayTitle(item);
        return {
          ebayOfferId: fakeId("offer"),
          inventoryItemId: fakeId("inv"),
          sku: item.sku,
        status: "created",
        title,
        requestPayload: {
          sku: item.sku,
          marketplaceId: getConfig().marketplaceId,
          format: listingConfig.format,
          categoryId: resolveCategoryIdForCard(item) || null,
          countryCode: "US",
          listingDescription: buildDescription(item),
          ...(listingConfig.format === "AUCTION"
            ? { listingDuration: listingConfig.listingDuration || DEFAULT_AUCTION_DURATION }
            : {}),
          ...(listingConfig.format === "AUCTION"
            ? {}
            : { availableQuantity: 1, quantityLimitPerBuyer: 1 }),
          listingPolicies: {
            paymentPolicyId: getConfig().paymentPolicyId || null,
            fulfillmentPolicyId: getFulfillmentPolicyIdForCard(item),
            returnPolicyId: getConfig().returnPolicyId || null,
            ...(listingConfig.format === "AUCTION"
              ? {}
              : { bestOfferTerms: normalizeBestOfferTerms({}, getCardPrice(item)) }),
          },
          pricingSummary,
        },
      };
    });
  }

  return createLiveOffers(cardItems);
}

export async function updateOfferPrices(offers) {
  if (!hasLiveConfig()) {
    return offers.map((offer) => ({
      ...offer,
      status: "updated",
      syncedAt: new Date().toISOString(),
    }));
  }

  return updateLiveOfferPrices(offers);
}

export async function publishOffers(offers) {
  if (!hasLiveConfig()) {
    return offers.map((offer) => ({
      ...offer,
      status: "published",
      listingUrl: `https://www.ebay.com/itm/${fakeId("listing")}`,
      publishedAt: new Date().toISOString(),
    }));
  }

  return publishLiveOffers(offers);
}

export async function deleteEbayOffer(offerId) {
  if (!hasLiveConfig()) return { status: "deleted", offerId };
  const response = await requestEbay(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, {
    method: "DELETE",
  });
  console.log("=== DELETE OFFER RESPONSE ===", offerId, JSON.stringify(response));
  return { status: "deleted", offerId };
}

export function buildEBayTitleForCard(card) {
  return buildEBayTitle(card);
}

export async function buildEBayDescriptionForCard(card, options = {}) {
  if (card.ebayDescription && !options.force) return card.ebayDescription;
  return buildEBayDescription(card);
}

export function buildItemSpecificsForCard(card) {
  return buildItemSpecifics(card);
}

export function getEbayConfig() {
  const config = getConfig();
  return {
    environment: config.environment,
    marketplaceId: config.marketplaceId,
    userAccessToken: config.userAccessToken,
    merchantLocationKey: config.merchantLocationKey,
    categoryId: config.categoryId,
    paymentPolicyId: config.paymentPolicyId,
    fulfillmentPolicyId: config.fulfillmentPolicyId,
    lessThan20FulfillmentPolicyId: config.lessThan20FulfillmentPolicyId,
    lessThan20MachinableFulfillmentPolicyId: config.lessThan20MachinableFulfillmentPolicyId,
    returnPolicyId: config.returnPolicyId,
    hasLiveConfig: hasLiveConfig(),
  };
}
