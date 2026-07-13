// Buyer-submitted Best Offer retrieval — confirmed via eBay's own docs and a
// live spike this session that this is Trading API only (GetBestOffers /
// RespondToBestOffer); there is no REST equivalent. The REST Inventory API
// can only ENABLE Best Offer on a listing (already done elsewhere in
// ebay.js via bestOfferEnabled), not read/respond to offers buyers submit.
//
// Also confirmed live: the existing OAuth user access token (obtained via
// the normal REST auth flow) works directly against the Trading API by
// passing it as X-EBAY-API-IAF-TOKEN instead of the legacy
// RequesterCredentials — no separate user re-authorization is needed.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEbayConfig, refreshEbayToken, xmlTagValue, xmlTagValues, decodeXmlEntities } from "./ebay.js";
import { nowIso } from "../lib/store.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cachePath = path.join(rootDir, "data", "best-offers-cache.json");

// Routes/services never import from app.js (see the other files in
// src/routes/) — app.js imports them, not the other way around — so this
// stays a tiny local equivalent of app.js's normalizeSalesCurrencyValue
// rather than crossing that boundary.
function normalizeMoney(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

// Escapes free-text for safe embedding in an OUTBOUND XML request body —
// the mirror-image of decodeXmlEntities (which parses INCOMING responses).
function encodeXmlEntities(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const TRADING_API_URL = "https://api.ebay.com/ws/api.dll";
const TRADING_API_SITE_ID = "0"; // EBAY-US
const TRADING_API_COMPATIBILITY_LEVEL = "1155";

// Confirmed live (not guessed) via a real spike call against several
// listings: eBay returns Ack=Failure with these specific messages for two
// expected, non-error states — neither should surface as a thrown error.
const NOT_ENABLED_PATTERN = /not best offer enabled/i;
const NOT_FOUND_PATTERN = /best offers? not found/i;

async function callTradingApi(callName, bodyXml, { retryOnExpiredToken = true } = {}) {
  const config = getEbayConfig();
  const response = await fetch(TRADING_API_URL, {
    method: "POST",
    headers: {
      "X-EBAY-API-COMPATIBILITY-LEVEL": TRADING_API_COMPATIBILITY_LEVEL,
      "X-EBAY-API-CALL-NAME": callName,
      "X-EBAY-API-SITEID": TRADING_API_SITE_ID,
      "X-EBAY-API-IAF-TOKEN": config.userAccessToken || "",
      "Content-Type": "text/xml",
    },
    body: bodyXml,
  });
  const text = await response.text();

  // Trading API reports an expired/invalid IAF token as Ack=Failure inside
  // a 200 response, not an HTTP 401 — same underlying condition
  // requestEbay() handles for the REST API, just surfaced differently.
  // Confirmed live the real message is "Auth token is hard expired, User
  // needs to generate a new token for this application." — no "iaf" in it
  // at all, so the original narrower pattern never matched and this whole
  // retry path was silently dead code until now.
  if (retryOnExpiredToken && /hard expired|invalid access token|expired iaf token|generate a new token/i.test(text)) {
    await refreshEbayToken();
    return callTradingApi(callName, bodyXml, { retryOnExpiredToken: false });
  }
  return text;
}

function parseBestOfferBlock(block) {
  const rawPrice = xmlTagValue(block, "Price");
  const price = normalizeMoney(rawPrice);
  return {
    bestOfferId: xmlTagValue(block, "BestOfferID"),
    price: Number.isFinite(price) ? price : null,
    status: xmlTagValue(block, "Status"),
    buyerUserId: xmlTagValue(block, "UserID") || xmlTagValue(block, "Buyer"),
    expirationTime: xmlTagValue(block, "ExpirationTime"),
    buyerMessage: xmlTagValue(block, "BuyerMessage"),
    quantity: Number(xmlTagValue(block, "Quantity")) || 1,
  };
}

// Returns best offers for a listing. The default "Active" filter returns
// only offers still awaiting a seller response (eBay labels their
// individual status "Pending" in the response — confirmed live 2026-07-09
// that the Active REQUEST filter does return them); pass status "All" to
// also get the full history (Accepted/Declined/Expired/Countered/
// Retracted), which is what the scan uses so already-resolved offers —
// including ones the auto-accept/decline thresholds handled before any
// human looked — stay visible instead of silently vanishing. Returns []
// for both "not Best Offer enabled" and "no offers yet" — normal, expected
// states for most listings, not failures. Throws for any other (genuinely
// unexpected) error response.
export async function getBestOffersForListing(itemId, { status = "Active" } = {}) {
  const bodyXml = `<?xml version="1.0" encoding="utf-8"?>
<GetBestOffersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID>
  <BestOfferStatus>${encodeXmlEntities(String(status))}</BestOfferStatus>
</GetBestOffersRequest>`;

  const text = await callTradingApi("GetBestOffers", bodyXml);
  const ack = xmlTagValue(text, "Ack");

  if (ack === "Failure") {
    const shortMessage = xmlTagValue(text, "ShortMessage") || "";
    if (NOT_ENABLED_PATTERN.test(shortMessage) || NOT_FOUND_PATTERN.test(shortMessage)) {
      return [];
    }
    const longMessage = xmlTagValue(text, "LongMessage") || shortMessage || "Unknown GetBestOffers error";
    throw new Error(`eBay GetBestOffers failed for item ${itemId}: ${decodeXmlEntities(longMessage)}`);
  }

  const blocks = xmlTagValues(text, "BestOffer");
  return blocks.map(parseBestOfferBlock).filter((offer) => offer.bestOfferId);
}

const VALID_ACTIONS = new Set(["Accept", "Decline", "Counter"]);

// Accepts, declines, or counters a single buyer-submitted Best Offer.
// Confirmed against eBay's own RespondToBestOffer reference: Action is one
// of "Accept"/"Decline"/"Counter" (exact strings), CounterOfferPrice is
// required only for "Counter", and this is a real, consequential,
// hard-to-reverse action against a real buyer — accepting completes the
// sale, declining/countering notifies the buyer immediately. Callers must
// get explicit user confirmation before invoking this for a specific offer;
// this function does not add its own confirmation gate.
export async function respondToBestOffer({ itemId, bestOfferId, action, counterOfferPrice, sellerResponse }) {
  // Both IDs are always eBay-issued numeric strings — reject anything else
  // outright rather than interpolating unvalidated input into the outbound
  // XML request body.
  if (!/^\d+$/.test(String(itemId || "")) || !/^\d+$/.test(String(bestOfferId || ""))) {
    throw new Error("respondToBestOffer requires numeric itemId and bestOfferId");
  }
  if (!VALID_ACTIONS.has(action)) {
    throw new Error(`respondToBestOffer: invalid action "${action}" — must be Accept, Decline, or Counter`);
  }
  if (action === "Counter" && !(Number.isFinite(counterOfferPrice) && counterOfferPrice > 0)) {
    throw new Error("respondToBestOffer: a positive counterOfferPrice is required for a Counter action");
  }

  const bodyXml = `<?xml version="1.0" encoding="utf-8"?>
<RespondToBestOfferRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID>
  <BestOfferID>${bestOfferId}</BestOfferID>
  <Action>${action}</Action>
  ${action === "Counter" ? `<CounterOfferPrice currencyID="USD">${counterOfferPrice}</CounterOfferPrice>` : ""}
  ${sellerResponse ? `<SellerResponse>${encodeXmlEntities(String(sellerResponse).slice(0, 250))}</SellerResponse>` : ""}
</RespondToBestOfferRequest>`;

  const text = await callTradingApi("RespondToBestOffer", bodyXml);
  const ack = xmlTagValue(text, "Ack");
  if (ack === "Failure") {
    const longMessage = xmlTagValue(text, "LongMessage") || xmlTagValue(text, "ShortMessage") || "Unknown RespondToBestOffer error";
    throw new Error(`eBay RespondToBestOffer (${action}) failed for offer ${bestOfferId}: ${decodeXmlEntities(longMessage)}`);
  }
  return { ok: true, action };
}

// Extracts the legacy numeric ItemID the Trading API needs from an eBay
// listing URL (e.g. "https://www.ebay.com/itm/236917541201" -> "236917541201").
export function extractItemIdFromListingUrl(listingUrl) {
  // eBay listing URLs come in two real shapes: bare (".../itm/236917541201")
  // and SEO-friendly with a title slug before the ID
  // (".../itm/2024-25-Panini-Select-.../236298326630"). The old
  // /\/itm\/(\d+)/ pattern matched the FIRST run of digits after "/itm/" —
  // for a slugged URL starting with a year (extremely common for sports
  // cards), that's the year, not the item ID. Confirmed live: this sent
  // "2024" as the itemId to RespondToBestOffer, which eBay correctly
  // rejected as an invalid item. The real numeric ID is always the LAST
  // path segment, so anchor the match there instead.
  const pathOnly = String(listingUrl || "").split("?")[0];
  const match = /\/itm\/(?:[^/]*\/)?(\d+)\/?$/.exec(pathOnly);
  return match ? match[1] : null;
}

// `extras` carries the scan's non-pending context: `resolved` (recently
// Accepted/Declined/Expired/Countered offers, so the UI can show what
// happened instead of resolved offers just vanishing between scans) and
// `notifiedOfferIds` (push-notification dedup — offer ids that have already
// been pinged, so a scheduled rescan doesn't re-notify the same offer).
export async function saveBestOffersSnapshot(entries, extras = {}) {
  const snapshot = { generatedAt: nowIso(), entries, ...extras };
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(snapshot, null, 2));
  return snapshot;
}

export async function getBestOffersSnapshot() {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return { generatedAt: null, entries: [] };
  }
}
