import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, sendJson, notFound } from "./lib/http.js";
import {
  createAuditEvent,
  createId,
  nowIso,
  withState,
  withStateReadOnly,
  getState,
  exportState,
  importState,
} from "./lib/store.js";
import { saveImageRecord } from "./lib/storage.js";
import { resolveGraderAndGrade } from "./services/ebay-condition.js";
import {
  processBatch,
  processCardItem,
  filterExactMatchComps,
  resolveGradeTarget,
} from "./jobs/pipeline.js";
import { getLiveCardComps } from "./services/comps.js";
import {
  getBestOffersForListing,
  extractItemIdFromListingUrl,
  getBestOffersSnapshot,
  saveBestOffersSnapshot,
  respondToBestOffer,
} from "./services/ebay-best-offers.js";
import {
  fetchEbayActiveListings,
  fetchEbayFulfillmentOrders,
  normalizeOrderDate,
  normalizeOrderLineDate,
  createDraftOffers,
  createInventoryItem,
  publishOffers,
  deleteEbayOffer,
  updateOfferPrices,
  getEbayConfig,
  buildEBayTitleForCard,
  buildEBayDescriptionForCard,
  buildItemSpecificsForCard,
  updateEbayListingPrice,
} from "./services/ebay.js";
import {
  fetchBrowseListingDatesByLegacyId,
  fetchBrowseListingImagesByLegacyId,
  hasBrowseConfig,
} from "./services/ebay-browse.js";
import { calculatePrice } from "./services/pricing.js";
import {
  parseApifySoldListings,
  searchApifySoldListings,
  getApifyMarketHeatReport,
  buildApifyLookupKey,
  getApifyUsageStatus,
  hasApifyConfig,
} from "./services/apify.js";
import { renameFile, getFileInfo, listFolder, createFolder, moveFile } from "./services/drive.js";
import { handleDriveApiRoutes } from "./routes/drive-routes.js";
import { handleGradingApiRoutes } from "./routes/grading-routes.js";
import { handleDaCardWorldApiRoutes } from "./routes/dacardworld-routes.js";
import { handleEbayOAuthRoutes } from "./routes/ebay-oauth-routes.js";
import {
  isAuthenticated,
  isAllowedEmail,
  getGoogleOAuthUrl,
  exchangeGoogleCode,
  setSessionCookie,
  clearSessionCookie,
} from "./services/auth.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(rootDir, "public");
const imagesDir = path.join(rootDir, "data", "images");

async function serveStatic(req, res, pathname) {
  const filePath =
    pathname === "/" ? path.join(publicDir, "index.html") : path.join(publicDir, pathname.slice(1));
  if (!filePath.startsWith(publicDir)) {
    return notFound(res);
  }
  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const contentType =
      ext === ".html"
        ? "text/html; charset=utf-8"
        : ext === ".css"
          ? "text/css; charset=utf-8"
          : ext === ".js"
            ? "text/javascript; charset=utf-8"
            : ext === ".png"
              ? "image/png"
              : "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

function cleanBatch(batch) {
  return { ...batch };
}

function isPublishedOffer(offer) {
  if (!offer) return false;
  if (offer.status === "sold" || offer.publishState === "sold") return false;
  return (
    offer.status === "published" ||
    offer.status === "active" ||
    offer.status === "listed" ||
    Boolean(offer.listingUrl)
  );
}

// The review UI's grade <select> options are literally "PSA 10", "BGS 9.5",
// etc. — matches GRADER_VALUE_IDS' synonym mapping in ebay-condition.js
// (which already treats BECKETT and BGS as the same real-world grader for
// eBay's own value IDs), since the dropdown only has a "BGS" optgroup.
const GRADE_DROPDOWN_GRADER_ALIASES = { BECKETT: "BGS" };

// Reconstructs the exact dropdown option string ("PSA 10") from whatever
// messier grader/grade text OCR actually produced, reusing the same
// grader/grade extraction already trusted for eBay's real condition
// descriptors — rather than requiring card.candidateGrade to already be an
// exact character-for-character match against an option's value.
function computeGradeDropdownValue(card) {
  const isGraded = card.candidateCondition === "graded" || Boolean(card.gradedFlag);
  if (!isGraded) return null;
  const { grader, grade } = resolveGraderAndGrade(card);
  if (!grader || !grade) return null;
  return `${GRADE_DROPDOWN_GRADER_ALIASES[grader] || grader} ${grade}`;
}

export function cleanCard(card, offers = []) {
  const normalized = { ...card, gradeDropdownValue: computeGradeDropdownValue(card) };
  if (normalized.publishState === "sold" || normalized.status === "sold") {
    normalized.status = "sold";
    normalized.publishState = "sold";
    return normalized;
  }
  const published = (
    normalized.publishState === "published" ||
    normalized.status === "listed" ||
    Boolean(normalized.listingUrl) ||
    offers.some(isPublishedOffer)
  );
  if (published) {
    normalized.status = "listed";
    normalized.publishState = "published";
  }
  return normalized;
}

function getRequestBaseUrl(req) {
  const rawForwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = rawForwardedProto || "http";
  const host = req.headers.host || `${process.env.HOST || "localhost"}:${process.env.PORT || 3000}`;
  return `${protocol}://${host}`;
}

// Card images can be stored two ways (see saveImageRecord in
// src/lib/storage.js): a Supabase Storage URL, or — whenever
// skipSupabaseUpload is set (Drive imports, Grading-tab transfers) — a
// disk-relative "/files/xxx.jpg" path served by this app's own static
// route. eBay's Inventory API rejects a relative path outright ("Invalid
// value for imageUrl. Incorrect URL format."), so any such path must be
// made absolute against this app's own public origin before it's sent.
function resolveEbayImageUrl(url, req) {
  if (!url) return url;
  const httpsSupabase = url.replace(/^http:\/\/([^:]+):\d+\/storage/, `${process.env.SUPABASE_URL}/storage`);
  if (httpsSupabase.startsWith("/")) {
    return `${getRequestBaseUrl(req)}${httpsSupabase}`;
  }
  return httpsSupabase;
}

function maskToken(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (raw.length <= 12) return `${raw.slice(0, 4)}...`;
  return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
}

function normalizeListingIdentityText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function listingPreviewLooksStale(card = {}) {
  const haystack = normalizeListingIdentityText(
    `${card.ebayTitle || ""} ${card.ebayDescription || ""} ${JSON.stringify(card.ebaySpecifics || {})}`,
  );
  if (!haystack) return true;
  const playerTokens = normalizeListingIdentityText(card.candidatePlayer || card.playerName || "")
    .split(" ")
    .filter((token) => token.length > 2);
  if (playerTokens.length && !playerTokens.some((token) => haystack.includes(token))) {
    return true;
  }
  return false;
}

function safeEbayHealthConfig() {
  const config = getEbayConfig();
  return {
    environment: config.environment,
    marketplaceId: config.marketplaceId,
    merchantLocationKey: config.merchantLocationKey,
    categoryId: config.categoryId,
    paymentPolicyId: config.paymentPolicyId,
    fulfillmentPolicyId: config.fulfillmentPolicyId,
    lessThan20FulfillmentPolicyId: config.lessThan20FulfillmentPolicyId,
    lessThan20MachinableFulfillmentPolicyId: config.lessThan20MachinableFulfillmentPolicyId,
    returnPolicyId: config.returnPolicyId,
    hasLiveConfig: Boolean(config.clientId && config.clientSecret && config.ruName),
    hasUserAccessToken: Boolean(config.userAccessToken),
    userAccessTokenPreview: maskToken(config.userAccessToken),
  };
}

function parsePrintRunInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return { printRun: null, serialNumber: null };
  const normalized = raw.replace(/^no\.\s*/i, "").trim();

  const exactSerialMatch = /^(\d{1,3})\s*\/\s*(\d{1,4})$/.exec(normalized);
  if (exactSerialMatch) {
    return {
      printRun: Number(exactSerialMatch[2]),
      serialNumber: `${exactSerialMatch[1]}/${exactSerialMatch[2]}`,
    };
  }

  const ofSerialMatch = /^(\d{1,3})\s*(?:of|out of)\s*(\d{1,4})$/i.exec(normalized);
  if (ofSerialMatch) {
    return {
      printRun: Number(ofSerialMatch[2]),
      serialNumber: `${ofSerialMatch[1]}/${ofSerialMatch[2]}`,
    };
  }

  const fallbackSerialMatch = /^#\s*(\d{1,3})\s*(\d{1,4})$/.exec(normalized);
  if (fallbackSerialMatch) {
    return {
      printRun: Number(fallbackSerialMatch[2]),
      serialNumber: `${fallbackSerialMatch[1]}/${fallbackSerialMatch[2]}`,
    };
  }

  const printRunValue = Number(normalized.replace(/^\//, ""));
  if (!Number.isFinite(printRunValue)) {
    return { printRun: null, serialNumber: null };
  }

  return {
    printRun: printRunValue,
    serialNumber: null,
  };
}

async function movePublishedDriveImages(card) {
  let sourceFolderId = card?.driveSourceFolderId;
  if (!sourceFolderId && (card?.driveFrontFileId || card?.driveBackFileId)) {
    const fileIds = [card.driveFrontFileId, card.driveBackFileId].filter(Boolean);
    for (const fileId of fileIds) {
      try {
        const fileInfo = await getFileInfo(fileId);
        const parents = Array.isArray(fileInfo?.parents) ? fileInfo.parents : [];
        const parentFolder = parents.find((id) => id && id !== "root") || parents[0];
        if (parentFolder) {
          sourceFolderId = parentFolder;
          if (!card.driveSourceFolderId) card.driveSourceFolderId = sourceFolderId;
          break;
        }
      } catch {
        // continue
      }
    }
  }
  if (!sourceFolderId) return;

  try {
    const today = new Date().toISOString().slice(0, 10);
    const listedFolderName = `${today} - listed`;
    const sourceFiles = await listFolder(sourceFolderId);

    const getOrCreateChildFolder = async (parentId, folderName) => {
      const children = await listFolder(parentId);
      const found = children.find(
        (entry) =>
          entry.mimeType === "application/vnd.google-apps.folder" && entry.name === folderName,
      );
      if (found) return found;
      return createFolder(parentId, folderName);
    };

      const publishedFolder = await getOrCreateChildFolder(sourceFolderId, "Published");
    const dateFolder = await getOrCreateChildFolder(publishedFolder.id, listedFolderName);
    const listedRegex = /listed/i;
    const imageRegex = /\.(jpg|jpeg|png|webp|gif|bmp|tiff|tif)$/i;
    const listedDatePattern = /listed\s*\d{4}-\d{2}-\d{2}/i;
    const movedIds = new Set();

    const buildListedName = (name, prefixLabel = "listed") => {
      const safeName = name || "";
      const fileParts = safeName.split(".");
      const ext = fileParts.length > 1 ? `.${fileParts.pop()}` : "";
      const base = fileParts.join(".");
      if (!listedRegex.test(base)) return `${base} - ${prefixLabel} ${today}${ext}`;
      if (listedDatePattern.test(base)) return safeName;
      return `${base} ${today}${ext}`;
    };

    const renameAndMove = async (fileId, fileName = null, renamePrefix = "listed") => {
      if (!fileId) return;
      const currentName = fileName || (await getFileInfo(fileId).then((info) => info.name));
      const listedName = buildListedName(currentName, renamePrefix);
      movedIds.add(fileId);
      if (listedName !== currentName) {
        try {
          await renameFile(fileId, listedName);
        } catch (error) {
          console.error("Failed to rename listed Drive file", error.message);
        }
      }
      try {
        await moveFile(fileId, dateFolder.id);
      } catch (error) {
        console.error("Failed to move listed Drive file", error.message);
      }
    };

    await renameAndMove(card.driveFrontFileId);
    await renameAndMove(card.driveBackFileId);

    for (const file of sourceFiles) {
      if (!file?.id || movedIds.has(file.id)) continue;
      const fileName = file.name || "";
      const isImage = (file.mimeType || "").startsWith("image/") || imageRegex.test(fileName);
      if (!isImage) continue;
      const hasTrackedImageIds = Boolean(card.driveFrontFileId || card.driveBackFileId);
      if (hasTrackedImageIds && !listedRegex.test(fileName)) continue;
      await renameAndMove(file.id, fileName, "listed");
    }
  } catch (error) {
    console.error("Failed to move published Drive images", error.message);
  }
}

async function moveListedCardDriveImages(card) {
  if (!card?.driveFrontFileId && !card?.driveBackFileId && !card?.driveSourceFolderId) return;
  await movePublishedDriveImages(card);
}

function getPublishedOfferForCard(card, offers = []) {
  return offers.find(
    (offer) =>
      offer.cardItemId === card.id &&
      (offer.status === "published" || offer.status === "active" || offer.status === "listed" || Boolean(offer.listingUrl)),
  );
}

function isCardPublished(card, offers = []) {
  const publishedOffer = getPublishedOfferForCard(card, offers);
  return (
    card.publishState === "published" ||
    card.status === "listed" ||
    Boolean(card.listingUrl) ||
    Boolean(publishedOffer)
  );
}

function normalizeOfferBestOfferTerms(offer) {
  const requestPayload = offer?.requestPayload || {};
  const bestOfferTerms = requestPayload.bestOfferTerms || {};
  if (bestOfferTerms.bestOfferEnabled === true) return false;
  offer.requestPayload = {
    ...requestPayload,
    bestOfferTerms: {
      ...bestOfferTerms,
      bestOfferEnabled: true,
    },
  };
  return true;
}

async function ensureBestOfferTermsInOffers(offers) {
  const toNormalize = offers.filter((offer) => {
    const bestOfferTerms = offer?.requestPayload?.bestOfferTerms || {};
    return bestOfferTerms.bestOfferEnabled !== true;
  });
  if (!toNormalize.length) return offers;

  const updated = await updateOfferPrices(toNormalize);
  if (!updated.length) return offers;
  const updatedByIdentity = new Map();
  for (const item of updated) {
    if (item.id) updatedByIdentity.set(`id:${item.id}`, item);
    if (item.ebayOfferId) updatedByIdentity.set(`offer:${item.ebayOfferId}`, item);
    if (item.sku) updatedByIdentity.set(`sku:${item.sku}`, item);
  }
  return offers.map((offer) => {
    const identityKeys = [
      offer.id ? `id:${offer.id}` : null,
      offer.ebayOfferId ? `offer:${offer.ebayOfferId}` : null,
      offer.sku ? `sku:${offer.sku}` : null,
    ].filter(Boolean);
    for (const key of identityKeys) {
      const match = updatedByIdentity.get(key);
      if (match) return match;
    }
    return offer;
  });
}

function parseBoolean(value) {
  return value === true || value === "true" || value === "1" || value === 1 || value === "on";
}

// Disabled 2026-07-04 pending a different AI grading provider — Ximilar's
// card-grader results weren't reliable enough to keep surfacing. Code stays
// in place (not deleted) so swapping providers later doesn't mean rebuilding
// this whole tab/flow from scratch. Flip GRADING_FEATURE_ENABLED=true to
// turn it back on. Gates the /api/grading/* routes (src/routes/grading-routes.js)
// and /send-to-grading below; /return-from-grading is deliberately NOT
// gated so a card already sent to grading before the disable isn't stranded.
function isGradingFeatureEnabled() {
  return parseBoolean(process.env.GRADING_FEATURE_ENABLED);
}

export function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIsoMonth(dateValue) {
  const d = safeDate(dateValue);
  if (!d) return null;
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${d.getUTCFullYear()}-${month}`;
}

function monthLabel(monthKey) {
  if (!monthKey) return "Unknown month";
  const [year, month] = monthKey.split("-");
  if (!year || !month) return monthKey;
  const d = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

function moneyAmount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `$${parsed.toFixed(2)}` : "n/a";
}

export function lineItemQuantity(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function lineItemPrice(lineItem = {}) {
  const candidates = [
    lineItem.lineItemCost,
    lineItem.totalAmount,
    lineItem.totalPrice,
    lineItem.price,
    lineItem.unitPrice,
    lineItem.cost,
    lineItem.grossAmount,
    lineItem.pricingSummary?.grossAmount,
    lineItem.grossUnitPrice,
    lineItem.unitCost,
    lineItem.pricingSummary?.grossPrice,
    lineItem.lineItemCost?.value,
    lineItem.lineItemCost?.value?.value,
  ];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === "string") {
      const parsed = Number(candidate.replace(/[$,\s]/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
    if (typeof candidate === "object") {
      const objectValue = candidate.value || candidate.amount;
      if (typeof objectValue === "number" && Number.isFinite(objectValue)) return objectValue;
      if (typeof objectValue === "string") {
        const parsed = Number(objectValue.replace(/[$,\s]/g, ""));
        if (Number.isFinite(parsed)) return parsed;
      }
      if (typeof objectValue === "object") {
        const nestedValue = objectValue.value;
        const parsed = Number(nestedValue);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }
  return null;
}

export function lineItemSku(lineItem = {}) {
  const candidates = [
    lineItem.sku,
    lineItem.skuId,
    lineItem.itemId,
    lineItem.inventoryId,
    lineItem.lineItemId,
    lineItem.sellerItemId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

export function lineItemDisplayName(lineItem = {}) {
  return String(
    lineItem.title ||
      lineItem.itemTitle ||
      lineItem.lineItemTitle ||
      lineItem.itemName ||
      lineItem.legacyItemTitle ||
      lineItem.item?.title ||
      lineItem.item?.itemTitle ||
      lineItem.item?.name ||
      lineItem.legacyItem?.title ||
      lineItem.name ||
      "",
  ).trim();
}

export function lineItemListingId(lineItem = {}) {
  const candidates = [
    lineItem.legacyItemId,
    lineItem.itemId,
    lineItem.listingId,
    lineItem.item?.itemId,
    lineItem.item?.legacyItemId,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value) return value;
  }
  return null;
}

function buildEbayItemUrl(itemId) {
  return itemId ? `https://www.ebay.com/itm/${encodeURIComponent(itemId)}` : null;
}

export function extractEbayListingId(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const itemMatch = /\/itm\/(?:[^/?#]+\/)?(\d+)/i.exec(raw);
  if (itemMatch?.[1]) return itemMatch[1];
  const digits = /^\d+$/.test(raw) ? raw : null;
  return digits;
}

function buildEbaySellerOrderUrl(orderId) {
  return orderId ? `https://www.ebay.com/sh/ord/details?orderid=${encodeURIComponent(orderId)}` : null;
}

export function lineItemTotal(lineItem = {}, fallbackQuantity) {
  const quantity = toPositiveInt(fallbackQuantity, lineItemQuantity(lineItem.quantity || fallbackQuantity)) || 1;
  const explicitTotal = lineItemPrice({
    totalPrice: lineItem.totalPrice,
    totalAmount: lineItem.totalAmount,
    pricingSummary: lineItem.pricingSummary,
    grossAmount: lineItem.grossAmount,
    amount: lineItem.amount,
  });
  if (explicitTotal != null) return explicitTotal;
  const parsedUnitPrice = lineItemPrice(lineItem);
  return parsedUnitPrice != null ? parsedUnitPrice * quantity : null;
}

export function normalizeSalesCurrencyValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function toSalesMonthLabel(value) {
  if (!value) return "Unknown month";
  const month = toIsoMonth(value);
  return monthLabel(month);
}

function toDaysListed(dateValue) {
  const parsed = safeDate(dateValue);
  if (!parsed) return null;
  const diff = Date.now() - parsed.getTime();
  return diff < 0 ? 0 : Math.floor(diff / (24 * 60 * 60 * 1000));
}

function listingAnalyticsKey(listingId, sku) {
  if (listingId) return `listing:${listingId}`;
  if (sku) return `sku:${sku}`;
  return null;
}

function listingCardAnalyticsKey(cardId) {
  return cardId ? `card:${cardId}` : null;
}

function matchesListingAgeFilter(daysListed, ageFilter) {
  const filter = String(ageFilter || "").trim().toLowerCase();
  if (!filter) return true;
  if (!Number.isFinite(daysListed)) return false;
  if (filter === "last30") return daysListed <= 30;
  if (filter === "last90") return daysListed <= 90;
  if (filter === "last180") return daysListed <= 180;
  if (filter === "last365") return daysListed <= 365;
  if (filter === "older180") return daysListed >= 180;
  if (filter === "older365") return daysListed >= 365;
  return true;
}

const CARD_TITLE_IGNORE_WORDS = new Set([
  "baseball",
  "basketball",
  "football",
  "soccer",
  "hockey",
  "card",
  "cards",
  "sports",
  "sport",
  "trading",
]);

export function normalizeCardTitleText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cardSetTokens(value) {
  return normalizeCardTitleText(value)
    .split(" ")
    .filter((token) => token && !CARD_TITLE_IGNORE_WORDS.has(token) && !/^\d+$/.test(token));
}

export function cardTitleCandidates(card = {}) {
  return [
    card.ebayTitle,
    buildCardSalesLabel(card),
  ]
    .map((value) => normalizeCardTitleText(value))
    .filter(Boolean);
}

export function scoreCardTitleMatch(title, card = {}) {
  const haystack = normalizeCardTitleText(title);
  if (!haystack) return -1;

  const titleCandidates = cardTitleCandidates(card);
  if (titleCandidates.some((candidate) => candidate === haystack)) return 100;

  const player = normalizeCardTitleText(card.candidatePlayer);
  if (!player || !haystack.includes(player)) return -1;

  let score = 10;
  const cardNumber = normalizeCardTitleText(card.candidateCardNumber);
  if (cardNumber) {
    if (!haystack.includes(cardNumber)) return -1;
    score += 8;
  }

  const year = normalizeCardTitleText(card.candidateYear);
  if (year && haystack.includes(year)) score += 4;

  const setTokens = cardSetTokens(card.candidateSetName);
  if (setTokens.length) {
    const matchedSetTokens = setTokens.filter((token) => haystack.includes(token));
    if (!matchedSetTokens.length) return -1;
    score += Math.min(6, matchedSetTokens.length * 2);
  }

  const parallel = normalizeCardTitleText(card.candidateParallel);
  if (parallel && haystack.includes(parallel)) score += 3;

  const variant = normalizeCardTitleText(card.candidateVariantLabel);
  if (variant && haystack.includes(variant)) score += 2;

  return score;
}

function pricingMetadataForCard(card = {}) {
  return {
    parallel: card?.candidateParallel || "",
    baseHint: Boolean(card?.candidateBaseHint),
    variantLabel: card?.candidateVariantLabel || "",
    rookieFlag: Boolean(card?.candidateRookieFlag),
    serialNumber: card?.serialNumber || null,
    printRun: card?.printRun || null,
  };
}

function normalizeStoredCompRecord(comp = {}) {
  return {
    source: comp.source || null,
    listingId: comp.listingId || comp.id || null,
    title: comp.title || comp.name || comp.keyword || null,
    conditionLabel: comp.conditionLabel || null,
    salePrice: comp.salePrice ?? comp.sale_price ?? null,
    shippingPrice: comp.shippingPrice ?? null,
    totalPrice: comp.totalPrice ?? comp.total_price ?? comp.price ?? comp.salePrice ?? comp.sale_price ?? null,
    soldAt: comp.soldAt || null,
    url: comp.url || null,
    matchScore: comp.matchScore ?? null,
  };
}

function dedupeStoredComps(comps = []) {
  const seen = new Set();
  const deduped = [];
  for (const rawComp of comps) {
    const comp = normalizeStoredCompRecord(rawComp);
    const key =
      comp.listingId ||
      comp.url ||
      `${normalizeCardTitleText(comp.title)}:${normalizeSalesCurrencyValue(comp.totalPrice ?? comp.salePrice) ?? ""}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(comp);
  }
  return deduped;
}

function deriveStoredExternalPricingSummary(card = {}, storedComps = []) {
  const allComps = dedupeStoredComps(
    [
      ...(Array.isArray(card.externalSoldComps) ? card.externalSoldComps : []),
      ...storedComps,
    ],
  );
  if (!allComps.length) return null;

  const pricing = calculatePrice({
    soldComps: allComps,
    activeListings: [],
    strategy: card.pricingStrategy || "sold_comps_p25",
    metadata: pricingMetadataForCard(card),
  });
  const compPrice = normalizeSalesCurrencyValue(
    pricing.recommendedPrice ?? pricing.soldMedian ?? pricing.soldP25,
  );
  if (!(Number.isFinite(compPrice) && compPrice > 0)) return null;

  const derivedLow = normalizeSalesCurrencyValue(pricing.soldP25 ?? compPrice);
  const derivedHigh = normalizeSalesCurrencyValue(pricing.soldMedian ?? compPrice);
  const low = Number.isFinite(derivedLow) && derivedLow > 0 ? Math.min(derivedLow, compPrice) : compPrice;
  const high = Number.isFinite(derivedHigh) && derivedHigh > 0 ? Math.max(derivedHigh, compPrice) : compPrice;

  return {
    requestedGrade:
      card?.compGradeOverride ||
      card?.candidateGrade ||
      (card?.candidateCondition === "graded" ? "Graded" : "Raw"),
    compPrice,
    low,
    high,
    countUsed: Number.isFinite(pricing.usedSoldCompCount) ? pricing.usedSoldCompCount : allComps.length,
    countRequested: allComps.length,
    timeWeighted: null,
    derivedFromStoredComps: true,
  };
}

function buildExternalCompsByCardId(state = {}) {
  const compsByCardId = new Map();
  for (const comp of state.comps || []) {
    if (!comp?.cardItemId) continue;
    const bucket = compsByCardId.get(comp.cardItemId) || [];
    bucket.push(comp);
    compsByCardId.set(comp.cardItemId, bucket);
  }
  return compsByCardId;
}

function ensureExternalPricingSummary(card, compsByCardId = new Map()) {
  if (!card) return card;
  const existingCompPrice = normalizeSalesCurrencyValue(card?.externalPricingSummary?.compPrice);
  if (Number.isFinite(existingCompPrice) && existingCompPrice > 0) return card;

  const storedComps = compsByCardId.get(card.id) || [];
  const hasExternalSource =
    Boolean(card?.externalCompSource) ||
    (Array.isArray(card?.externalSoldComps) && card.externalSoldComps.length > 0) ||
    storedComps.length > 0;
  if (!hasExternalSource) return card;

  const summary = deriveStoredExternalPricingSummary(card, storedComps);
  if (!summary) return card;

  card.externalPricingSummary = summary;
  if (!card.externalCompSource) {
    card.externalCompSource = "soldcomps";
  }
  return card;
}

function rememberCardEbayTitle(card, title) {
  const normalized = String(title || "").trim();
  if (!card || !normalized) return card;
  if (card.ebayTitle !== normalized) {
    card.ebayTitle = normalized;
    card.updatedAt = nowIso();
  }
  return card;
}

export function rememberOfferEbayTitle(offer, title) {
  const normalized = String(title || "").trim();
  if (!offer || !normalized) return offer;
  if (offer.ebayTitle !== normalized) {
    offer.ebayTitle = normalized;
    offer.updatedAt = nowIso();
  }
  return offer;
}

function normalizeImageUrlList(values = []) {
  return values
    .map((value) => String(value || "").trim())
    .filter((value, index, list) => value && value !== "NONE" && list.indexOf(value) === index);
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

export function pickImageUrl(...values) {
  const flattened = values.flatMap((value) => (Array.isArray(value) ? value : [value]));
  return normalizeImageUrlList(flattened)[0] || "";
}

function buildTrackedOffersFromCards(cards = []) {
  return (Array.isArray(cards) ? cards : [])
    .filter((card) =>
      Boolean(
        card &&
        (
          card.publishState === "published" ||
          card.status === "listed" ||
          card.listingUrl ||
          card.listingId
        ),
      ),
    )
    .map((card) => {
      const imageUrls = normalizeImageUrlList([
        card?.imageUrl,
        card?.frontImageUrl,
        card?.backImageUrl,
        ...(Array.isArray(card?.imageUrls) ? card.imageUrls : []),
      ]);
      return {
        id: card?.id ? `${card.id}_tracked_offer` : null,
        cardItemId: card?.id || null,
        ebayOfferId: card?.ebayOfferId || card?.offerId || null,
        listingId: card?.listingId || null,
        listingUrl: card?.listingUrl || null,
        sku: card?.sku || null,
        price: normalizeSalesCurrencyValue(card?.recommendedPrice ?? card?.price),
        format: card?.format || "FIXED_PRICE",
        status: card?.publishState === "published" ? "PUBLISHED" : (card?.status || "listed"),
        publishState: card?.publishState || (card?.status === "listed" ? "published" : null),
        title: card?.ebayTitle || null,
        imageUrl: imageUrls[0] || null,
        imageUrls,
        createdAt: card?.createdAt || nowIso(),
        updatedAt: card?.updatedAt || nowIso(),
      };
    });
}

function ensureTrackedOfferForListing(state, { offerBySku, offerByListingId }, listing = {}) {
  const listingId = listing?.listingId ? String(listing.listingId) : null;
  const sku = listing?.sku ? String(listing.sku) : null;
  let offer =
    (listingId ? offerByListingId.get(listingId) : null) ||
    (sku ? offerBySku.get(sku) : null) ||
    null;

  if (!offer) {
    offer = {
      id: createId(state, "offer"),
      cardItemId: null,
      ebayOfferId: listing?.offerId || null,
      listingId,
      listingUrl: listing?.listingUrl || null,
      sku,
      price: normalizeSalesCurrencyValue(listing?.currentPrice),
      format: listing?.format || "FIXED_PRICE",
      status: listing?.status || "PUBLISHED",
      publishState: "published",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    state.offers.push(offer);
  }

  if (listingId && !offer.listingId) offer.listingId = listingId;
  if (listing?.listingUrl && !offer.listingUrl) offer.listingUrl = listing.listingUrl;
  if (sku && !offer.sku) offer.sku = sku;
  if (listing?.offerId && !offer.ebayOfferId) offer.ebayOfferId = listing.offerId;
  if (listing?.format && !offer.format) offer.format = listing.format;
  if (listing?.status) offer.status = listing.status;
  const normalizedPrice = normalizeSalesCurrencyValue(listing?.currentPrice);
  if (normalizedPrice != null) offer.price = normalizedPrice;
  const imageUrls = normalizeImageUrlList([
    listing?.imageUrl,
    ...(Array.isArray(listing?.imageUrls) ? listing.imageUrls : []),
  ]);
  if (imageUrls.length) {
    offer.imageUrl = imageUrls[0];
    offer.imageUrls = normalizeImageUrlList([
      ...(Array.isArray(offer.imageUrls) ? offer.imageUrls : []),
      ...imageUrls,
    ]);
  }
  rememberOfferEbayTitle(offer, listing?.title || "");

  if (sku) offerBySku.set(sku, offer);
  if (listingId) offerByListingId.set(listingId, offer);
  return offer;
}

function hasMeaningfulExternalPricingSummary(summary) {
  const compPrice = normalizeSalesCurrencyValue(summary?.compPrice);
  return Number.isFinite(compPrice) && compPrice > 0;
}

export function buildEbayPricingSummary(record = {}, soldComps = [], activeListings = []) {
  const pricing = calculatePrice({
    soldComps: Array.isArray(soldComps) ? soldComps : [],
    activeListings: Array.isArray(activeListings) ? activeListings : [],
    strategy: record?.pricingStrategy || "sold_comps_p25",
    metadata: {
      parallel: record?.candidateParallel || "",
      baseHint: Boolean(record?.candidateBaseHint),
      variantLabel: record?.candidateVariantLabel || "",
      rookieFlag: Boolean(record?.candidateRookieFlag),
      serialNumber: record?.serialNumber || null,
      printRun: record?.printRun || null,
    },
  });
  const compPrice = normalizeSalesCurrencyValue(
    pricing?.recommendedPrice ?? pricing?.soldMedian ?? pricing?.soldP25,
  );
  if (!(Number.isFinite(compPrice) && compPrice > 0)) return null;
  const lowPrice = normalizeSalesCurrencyValue(pricing?.soldP25 ?? compPrice) ?? compPrice;
  const highPrice = normalizeSalesCurrencyValue(pricing?.soldMedian ?? compPrice) ?? compPrice;
  return {
    source: "ebay_image_search",
    compPrice,
    targetPrice: compPrice,
    lowPrice,
    highPrice,
    low: lowPrice,
    high: highPrice,
    strategy: pricing?.strategy || "sold_comps_p25",
    confidence: pricing?.confidence || "low",
    reason: pricing?.reason || null,
    usedSoldCompCount: Number.isFinite(pricing?.soldCompCount) ? pricing.soldCompCount : soldComps.length,
    countRequested: soldComps.length,
    soldMedian: normalizeSalesCurrencyValue(pricing?.soldMedian),
    soldP25: normalizeSalesCurrencyValue(pricing?.soldP25),
    // Match-quality evidence, previously discarded here — callers that need
    // to gate on "was this actually a confirmed match" (see the scheduled
    // repricer's exact-match requirement) need these, not just the bare
    // price numbers above.
    soldParallelFilterMode: pricing?.evidence?.soldParallelFilterMode ?? null,
    activeParallelFilterMode: pricing?.evidence?.activeParallelFilterMode ?? null,
    updatedAt: nowIso(),
  };
}

// Compares a listing's current price against its comp-derived target price and
// classifies it aligned/overpriced/underpriced. Shared by the manual reprice
// route and the scheduled repricing job.
export function buildManualRepricingSignal(card, offer, price) {
  const pricingSummary = offer?.externalPricingSummary || card?.externalPricingSummary || null;
  const recommendedPrice = normalizeSalesCurrencyValue(card?.recommendedPrice);
  const source = pricingSummary?.source || (pricingSummary ? "soldcomps" : "recommended");
  const rawTarget = pricingSummary?.compPrice ?? recommendedPrice;
  const targetPrice = normalizeSalesCurrencyValue(rawTarget);
  let low = normalizeSalesCurrencyValue(pricingSummary?.low);
  let high = normalizeSalesCurrencyValue(pricingSummary?.high);

  const hasMeaningfulTarget = Number.isFinite(targetPrice) && targetPrice > 0;
  const hasMeaningfulRange =
    (Number.isFinite(low) && low > 0) || (Number.isFinite(high) && high > 0);

  if (!hasMeaningfulTarget && !hasMeaningfulRange) {
    return {
      status: "unavailable",
      source,
      targetPrice: null,
      low: null,
      high: null,
      deltaAmount: null,
      deltaPct: null,
    };
  }

  if (!Number.isFinite(low) && hasMeaningfulTarget) {
    low = normalizeSalesCurrencyValue(targetPrice * 0.9);
  }
  if (!Number.isFinite(high) && hasMeaningfulTarget) {
    high = normalizeSalesCurrencyValue(targetPrice * 1.1);
  }

  if (!hasMeaningfulTarget || !Number.isFinite(price)) {
    return {
      status: "unavailable",
      source,
      targetPrice: hasMeaningfulTarget ? targetPrice : null,
      low: Number.isFinite(low) && low > 0 ? low : null,
      high: Number.isFinite(high) && high > 0 ? high : null,
      deltaAmount: null,
      deltaPct: null,
    };
  }

  const deltaAmount = normalizeSalesCurrencyValue(price - targetPrice) || 0;
  const deltaPct = targetPrice ? deltaAmount / targetPrice : null;
  let status = "aligned";

  if (
    (Number.isFinite(high) && price > high) ||
    (Number.isFinite(deltaPct) && deltaPct >= 0.15)
  ) {
    status = "overpriced";
  } else if (
    (Number.isFinite(low) && price < low) ||
    (Number.isFinite(deltaPct) && deltaPct <= -0.15)
  ) {
    status = "underpriced";
  }

  return {
    status,
    source,
    targetPrice,
    low: Number.isFinite(low) ? low : null,
    high: Number.isFinite(high) ? high : null,
    deltaAmount,
    deltaPct: Number.isFinite(deltaPct) ? deltaPct : null,
  };
}

function inferSportFromTitle(title = "") {
  const haystack = normalizeCardTitleText(title);
  if (!haystack) return "";
  if (
    /\b(nba|wnba|basketball|hoops|prizm basketball|select basketball|donruss basketball)\b/.test(
      haystack,
    )
  ) {
    return "basketball";
  }
  if (
    /\b(nfl|football|optic football|prizm football|select football|mosaic football)\b/.test(
      haystack,
    )
  ) {
    return "football";
  }
  if (
    /\b(mlb|baseball|topps|bowman|donruss baseball|chrome baseball)\b/.test(haystack)
  ) {
    return "baseball";
  }
  if (
    /\b(soccer|premier league|fifa|uefa|la liga|serie a|bundesliga|mls|donruss soccer|select soccer)\b/.test(
      haystack,
    )
  ) {
    return "soccer";
  }
  return "";
}

export async function withTimeout(promise, timeoutMs, label = "Operation") {
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

export function buildExternalCompLookupMetadata(card = {}, titleHint = "", imageUrl = "") {
  return {
    playerName: card?.candidatePlayer || "",
    year: card?.candidateYear || null,
    setName: card?.candidateSetName || "",
    cardNumber: card?.candidateCardNumber || "",
    parallel: card?.candidateParallel || "",
    grade: card?.candidateGrade || "",
    gradedFlag: card?.candidateCondition === "graded",
    compGradeOverride: card?.compGradeOverride || null,
    compMatchMode: card?.compMatchMode || "auto",
    rookieFlag: Boolean(card?.candidateRookieFlag),
    variantLabel: card?.candidateVariantLabel || "",
    serialNumber: card?.serialNumber || null,
    printRun: card?.printRun || null,
    autographFlag: Boolean(card?.candidateAutoHint),
    sport: card?.candidateSport || "",
    titleHint: titleHint || card?.ebayTitle || "",
    imageUrl: pickImageUrl(
      imageUrl,
      card?.imageUrl,
      card?.frontImageUrl,
      card?.backImageUrl,
      card?.imageUrls,
    ),
  };
}

export function buildOfferExternalCompLookupMetadata(offer = {}, titleHint = "", imageUrl = "") {
  const stableTitle = String(titleHint || offer?.ebayTitle || offer?.title || "").trim();
  return {
    playerName: "",
    year: null,
    setName: "",
    cardNumber: "",
    parallel: "",
    grade: "",
    gradedFlag: false,
    compGradeOverride: null,
    compMatchMode: "auto",
    rookieFlag: /\b(?:rookie|rc)\b/i.test(stableTitle),
    variantLabel: "",
    serialNumber: null,
    printRun: null,
    autographFlag: /\b(?:autograph|auto|signed|signature)\b/i.test(stableTitle),
    sport: inferSportFromTitle(stableTitle),
    titleHint: stableTitle,
    imageUrl: pickImageUrl(
      imageUrl,
      offer?.imageUrl,
      offer?.frontImageUrl,
      offer?.backImageUrl,
      offer?.imageUrls,
    ),
  };
}

function hasFreshLookupKey(record, metadata = {}) {
  if (!record) return false;
  return String(record?.apifyLookupKey || "") === buildApifyLookupKey(metadata);
}

async function hydrateExternalPricingSummary(
  card,
  {
    compsByCardId = new Map(),
    lookupCache = new Map(),
    lookupBudget = { remaining: 0 },
    titleHint = "",
    imageUrl = "",
  } = {},
) {
  if (!card) return card;
  ensureExternalPricingSummary(card, compsByCardId);
  const metadata = buildExternalCompLookupMetadata(card, titleHint, imageUrl);
  const lookupKeyMatches = hasFreshLookupKey(card, metadata);
  const existingCompPrice = normalizeSalesCurrencyValue(card?.externalPricingSummary?.compPrice);
  if (lookupKeyMatches && Number.isFinite(existingCompPrice) && existingCompPrice > 0) return card;
  if (!hasApifyConfig()) return card;

  const attemptedAt = Date.parse(String(card?.externalCompLookupAttemptedAt || ""));
  if (lookupKeyMatches && Number.isFinite(attemptedAt) && Date.now() - attemptedAt < 15 * 60 * 1000) {
    return card;
  }

  if (lookupCache.has(card.id)) {
    await lookupCache.get(card.id);
    return card;
  }

  if (!Number.isFinite(lookupBudget.remaining) || lookupBudget.remaining <= 0) {
    return card;
  }
  lookupBudget.remaining -= 1;

  const lookupPromise = (async () => {
    try {
      const lookupTimeoutMs = Math.max(
        1000,
        // Raised from 12s/15s-ceiling: requesting up to 50 sold comps per
        // keyword (was 10) takes noticeably longer per SoldComps call
        // (~4-5s observed per keyword, up to 2 keywords sequentially), so
        // the old ceiling was tripping this timeout and silently leaving
        // cards with 0 sold comps even when real matches existed.
        Math.min(30000, toPositiveInt(process.env.SOLDCOMPS_REPRICE_LOOKUP_TIMEOUT_MS, 20000)),
      );
      const result = await withTimeout(
        searchApifySoldListings(metadata),
        lookupTimeoutMs,
        "Sold-comp repricing lookup",
      );
      const detectedSource = String(result?.source || "").toLowerCase();
      card.externalCompLookupAttemptedAt = nowIso();
      card.apifyLookupKey = buildApifyLookupKey(metadata);
      const imported = Array.isArray(result?.comps) ? result.comps.slice(0, 50) : [];
      if (!imported.length) return;

      card.externalSoldComps = imported;
      card.externalCompSource = detectedSource || "soldcomps";
      card.externalCompMatch = result?.cardMatch || null;
      card.externalCompMatchWarning = result?.cardMatchWarning || null;
      card.externalPricingSummary =
        result?.pricingSummary || deriveStoredExternalPricingSummary(card, compsByCardId.get(card.id) || []) || null;
      card.externalCompUpdatedAt = nowIso();
      card.apifySearchKeywords = Array.isArray(result?.keywordsUsed) ? result.keywordsUsed : [];
      card.apifySearchQuery = card.apifySearchKeywords.length ? card.apifySearchKeywords.join(" · ") : null;
      delete card.apifyError;
    } catch (error) {
      card.externalCompLookupAttemptedAt = nowIso();
      card.apifyError = error?.message || String(error);
    }
  })();

  lookupCache.set(card.id, lookupPromise);
  await lookupPromise;
  return card;
}

const externalRepriceQueue = [];
const externalRepriceQueuedIds = new Set();
let externalRepriceWorkerPromise = null;
const offerExternalRepriceQueue = [];
const offerExternalRepriceQueuedKeys = new Set();
let offerExternalRepriceWorkerPromise = null;

function getExternalRepriceQueueStatus() {
  return {
    cardQueueLength: externalRepriceQueue.length,
    cardQueueActive: Boolean(externalRepriceWorkerPromise),
    offerQueueLength: offerExternalRepriceQueue.length,
    offerQueueActive: Boolean(offerExternalRepriceWorkerPromise),
  };
}

async function drainExternalRepriceQueue() {
  if (externalRepriceWorkerPromise) return externalRepriceWorkerPromise;
  const pauseMs = Math.max(
    0,
    Math.min(60000, toPositiveInt(process.env.SOLDCOMPS_REPRICE_QUEUE_PAUSE_MS, 6500)),
  );
  externalRepriceWorkerPromise = (async () => {
    while (externalRepriceQueue.length) {
      const job = externalRepriceQueue.shift();
      if (!job?.cardId) continue;
      try {
        const snapshot = await getState();
        const snapshotCard = (snapshot.cardItems || []).find((entry) => entry.id === job.cardId);
        if (!snapshotCard) continue;

        const compsByCardId = buildExternalCompsByCardId(snapshot);
        await hydrateExternalPricingSummary(snapshotCard, {
          compsByCardId,
          lookupCache: new Map(),
          lookupBudget: { remaining: 1 },
          titleHint: job.titleHint || "",
          imageUrl: job.imageUrl || "",
        });

        const cardPatch = { ...snapshotCard, updatedAt: nowIso() };
        await withState(async (state) => {
          const liveCard = (state.cardItems || []).find((entry) => entry.id === job.cardId);
          if (!liveCard) return;
          Object.assign(liveCard, cardPatch);
        });
      } catch {
        // background hydration is best-effort
      } finally {
        externalRepriceQueuedIds.delete(job.cardId);
      }
      if (pauseMs && externalRepriceQueue.length) {
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
      }
    }
  })().finally(() => {
    externalRepriceWorkerPromise = null;
    if (externalRepriceQueue.length) {
      setTimeout(() => {
        void drainExternalRepriceQueue();
      }, 0);
    }
  });
  return externalRepriceWorkerPromise;
}

function scheduleExternalRepriceHydration(cardId, titleHint = "", imageUrl = "") {
  if (!hasApifyConfig() || !cardId) return;
  if (externalRepriceQueuedIds.has(cardId)) return;
  externalRepriceQueuedIds.add(cardId);
  externalRepriceQueue.push({ cardId, titleHint, imageUrl });
  setTimeout(() => {
    void drainExternalRepriceQueue();
  }, 0);
}

function offerHydrationKey({ listingId, sku } = {}) {
  if (listingId) return `listing:${listingId}`;
  if (sku) return `sku:${sku}`;
  return null;
}

async function drainOfferExternalRepriceQueue() {
  if (offerExternalRepriceWorkerPromise) return offerExternalRepriceWorkerPromise;
  const pauseMs = Math.max(
    0,
    Math.min(60000, toPositiveInt(process.env.SOLDCOMPS_REPRICE_QUEUE_PAUSE_MS, 6500)),
  );
  offerExternalRepriceWorkerPromise = (async () => {
    while (offerExternalRepriceQueue.length) {
      const job = offerExternalRepriceQueue.shift();
      const jobKey = offerHydrationKey(job);
      if (!jobKey) continue;
      try {
        const snapshot = await getState();
        const snapshotOffer = (snapshot.offers || []).find((entry) =>
          (job.listingId && String(entry?.listingId || "") === String(job.listingId)) ||
          (job.sku && String(entry?.sku || "") === String(job.sku)),
        );
        if (!snapshotOffer) continue;
        const metadata = buildOfferExternalCompLookupMetadata(snapshotOffer, job.titleHint || "", job.imageUrl || "");
        const lookupKeyMatches = hasFreshLookupKey(snapshotOffer, metadata);
        if (lookupKeyMatches && hasMeaningfulExternalPricingSummary(snapshotOffer.externalPricingSummary)) continue;
        const attemptedAt = Date.parse(String(snapshotOffer?.externalCompLookupAttemptedAt || ""));
        if (lookupKeyMatches && Number.isFinite(attemptedAt) && Date.now() - attemptedAt < 15 * 60 * 1000) continue;

        const lookupTimeoutMs = Math.max(
          1000,
          // Raised from 12s/15s-ceiling: requesting up to 50 sold comps per
        // keyword (was 10) takes noticeably longer per SoldComps call
        // (~4-5s observed per keyword, up to 2 keywords sequentially), so
        // the old ceiling was tripping this timeout and silently leaving
        // cards with 0 sold comps even when real matches existed.
        Math.min(30000, toPositiveInt(process.env.SOLDCOMPS_REPRICE_LOOKUP_TIMEOUT_MS, 20000)),
        );
        const result = await withTimeout(
          searchApifySoldListings(metadata),
          lookupTimeoutMs,
          "Sold-comp offer repricing lookup",
        );
        snapshotOffer.externalCompLookupAttemptedAt = nowIso();
        const detectedSource = String(result?.source || "").toLowerCase();
        const imported = Array.isArray(result?.comps) ? result.comps.slice(0, 50) : [];
        if (!imported.length) continue;

        rememberOfferEbayTitle(snapshotOffer, metadata.titleHint);
        snapshotOffer.externalCompSource = detectedSource || "soldcomps";
        snapshotOffer.externalCompMatch = result?.cardMatch || null;
        snapshotOffer.externalCompMatchWarning = result?.cardMatchWarning || null;
        snapshotOffer.externalPricingSummary = result?.pricingSummary || null;
        snapshotOffer.apifyLookupKey = buildApifyLookupKey(metadata);
        snapshotOffer.externalCompUpdatedAt = nowIso();
        snapshotOffer.apifySearchKeywords = Array.isArray(result?.keywordsUsed) ? result.keywordsUsed : [];
        snapshotOffer.apifySearchQuery = snapshotOffer.apifySearchKeywords.length ? snapshotOffer.apifySearchKeywords.join(" · ") : null;
        delete snapshotOffer.apifyError;

        const offerPatch = { ...snapshotOffer };
        await withState(async (state) => {
          const liveOffer = (state.offers || []).find((entry) =>
            (job.listingId && String(entry?.listingId || "") === String(job.listingId)) ||
            (job.sku && String(entry?.sku || "") === String(job.sku)),
          );
          if (!liveOffer) return;
          Object.assign(liveOffer, offerPatch);
        });
      } catch {
        // background hydration is best-effort
      } finally {
        offerExternalRepriceQueuedKeys.delete(jobKey);
      }
      if (pauseMs && offerExternalRepriceQueue.length) {
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
      }
    }
  })().finally(() => {
    offerExternalRepriceWorkerPromise = null;
    if (offerExternalRepriceQueue.length) {
      setTimeout(() => {
        void drainOfferExternalRepriceQueue();
      }, 0);
    }
  });
  return offerExternalRepriceWorkerPromise;
}

function scheduleOfferExternalRepriceHydration({ listingId, sku, titleHint = "", imageUrl = "" } = {}) {
  if (!hasApifyConfig()) return;
  const key = offerHydrationKey({ listingId, sku });
  if (!key || offerExternalRepriceQueuedKeys.has(key)) return;
  offerExternalRepriceQueuedKeys.add(key);
  offerExternalRepriceQueue.push({ listingId, sku, titleHint, imageUrl });
  setTimeout(() => {
    void drainOfferExternalRepriceQueue();
  }, 0);
}

let bestOffersRefreshInProgress = false;

// Buyer-side counterpart to buildManualRepricingSignal's overpriced/
// underpriced/aligned framing: judges whether an incoming Best Offer is
// reasonable against the SAME exact-match-gated comp evidence the scheduled
// repricer requires (see filterExactMatchComps/resolveGradeTarget in
// pipeline.js) — an unconfirmed match is reported as such rather than
// guessing, same discipline as the repricer.
function assessBestOffer(offerAmount, pricingSummary, hasExactMatch) {
  if (!hasExactMatch || !pricingSummary) {
    return { verdict: "unconfirmed", reason: "No exact-match comps found — reasonableness can't be confirmed." };
  }
  const low = Number.isFinite(pricingSummary.low) ? pricingSummary.low : pricingSummary.compPrice;
  const high = Number.isFinite(pricingSummary.high) ? pricingSummary.high : pricingSummary.compPrice;
  if (Number.isFinite(low) && offerAmount < low) {
    return { verdict: "below_market", reason: `Offer is below the confirmed comp range ($${low}-$${high}).` };
  }
  if (Number.isFinite(high) && offerAmount > high) {
    return { verdict: "above_market", reason: `Offer is above the confirmed comp range ($${low}-$${high}).` };
  }
  return { verdict: "within_range", reason: `Offer falls within the confirmed comp range ($${low}-$${high}).` };
}

// Fetches pending Best Offers for EVERY active, Best-Offer-enabled listing
// on the seller's actual eBay account (Trading API GetMyeBaySelling via
// fetchEbayActiveListings — the same account-wide source the Listings
// dashboard uses), not just listings this app happens to have a local
// card/offer record for. A listing created outside this app's own
// import/publish flow, or one whose local record is missing/desynced,
// still gets checked — confirmed as a real gap live (two pending offers on
// tracked listings weren't found because the old version only ever walked
// state.cardItems/state.offers). Local card data is still used for the
// exact-match comp lookup whenever a matching local record exists; when it
// doesn't, the offer is still surfaced with verdict "unconfirmed" rather
// than being silently skipped.
async function refreshBestOffers() {
  const { trackedOffers, cardById } = await withStateReadOnly(async (state) => {
    const cards = Array.isArray(state.cardItems) ? state.cardItems : [];
    return {
      trackedOffers: [
        ...(Array.isArray(state.offers) ? state.offers.map((o) => ({ ...o })) : []),
        ...buildTrackedOffersFromCards(cards),
      ],
      cardById: new Map(cards.map((card) => [card.id, { ...card }])),
    };
  });

  // pageSize 200 (the Trading/Inventory API max) x maxPages 5 = up to 1000
  // listings — comfortably covers a large active seller account (confirmed
  // this one currently has ~850 live listings; the old 100 x 5 = 500 cap
  // would have silently missed roughly 350 of them).
  const activeListings = await fetchEbayActiveListings({ offers: trackedOffers, pageSize: 200, maxPages: 5 });
  // Not pre-filtered by listing.bestOfferEnabled — confirmed live that
  // GetMyeBaySelling's ActiveList doesn't reliably return BestOfferDetails
  // at all (even with DetailLevel=ReturnAll), so that flag can't be trusted
  // to decide which listings to skip. getBestOffersForListing() already
  // handles "this listing isn't Best-Offer-enabled" as a normal empty
  // result rather than an error, so it's safe (if a bit more Trading-API-
  // call-heavy) to just ask every active listing directly.
  const candidates = activeListings.filter((listing) => listing?.listingId || listing?.listingUrl);

  const entries = [];
  // Higher than the old 3 — GetBestOffers is a lightweight, free Trading
  // API call (unlike Apify's paid comp lookups), and with the
  // bestOfferEnabled pre-filter gone every active listing on the account
  // now gets checked, which can be a few hundred for an active seller.
  const concurrency = 8;
  const queue = [...candidates];
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
      while (queue.length) {
        const listing = queue.shift();
        const itemId = String(listing.listingId || extractItemIdFromListingUrl(listing.listingUrl) || "").trim();
        if (!itemId) continue;
        const card = listing.cardItemId ? cardById.get(listing.cardItemId) || null : null;
        const listingUrl = listing.listingUrl || `https://www.ebay.com/itm/${itemId}`;
        try {
          const bestOffers = await getBestOffersForListing(itemId);
          if (!bestOffers.length) continue;

          // Same fallback the reprice scheduler already uses for a card-less
          // offer (see computeReprice in reprice-scheduler.js): a title/
          // image-based comp lookup with no local record is strictly better
          // than skipping comps entirely, even though the identity match is
          // looser (isRelevantComp passes an unset player/year/set/cardNumber
          // through rather than failing it) — assessBestOffer still reports
          // "unconfirmed" whenever the evidence is thin, so this never
          // overclaims confidence it doesn't have.
          const imageUrl = pickImageUrl(listing?.imageUrl || "", card?.frontImageUrl || "", card?.backImageUrl || "");
          const lookupMetadata = card
            ? buildExternalCompLookupMetadata(card, listing?.title || "", imageUrl)
            : buildOfferExternalCompLookupMetadata({ ebayTitle: listing?.title || "" }, listing?.title || "", imageUrl);
          const lookupResult = await withTimeout(
            getLiveCardComps(lookupMetadata, null, null, null, card?.externalSoldComps || [], imageUrl),
            20000,
            "Best Offer comp lookup",
          );
          const gradeTarget = resolveGradeTarget(card || {});
          const filteredSold = filterExactMatchComps(lookupResult.sold, lookupMetadata, gradeTarget);
          const filteredActive = filterExactMatchComps(lookupResult.active, lookupMetadata, gradeTarget);
          const pricingSummary = buildEbayPricingSummary(card || { candidateParallel: "" }, filteredSold, filteredActive);
          const parallelConfirmed =
            !lookupMetadata.parallel ||
            pricingSummary?.soldParallelFilterMode === "exact_parallel" ||
            pricingSummary?.soldParallelFilterMode === "similar_parallel";
          const hasExactMatch = filteredSold.length > 0 && parallelConfirmed;

          for (const bestOffer of bestOffers) {
            const assessment = assessBestOffer(bestOffer.price, pricingSummary, hasExactMatch);
            entries.push({
              cardId: card?.id || null,
              offerId: listing.id || null,
              listingUrl,
              cardTitle: listing.title || card?.ebayTitle || "",
              currentPrice: normalizeSalesCurrencyValue(listing.currentPrice ?? card?.recommendedPrice),
              bestOfferId: bestOffer.bestOfferId,
              offerAmount: bestOffer.price,
              buyerUserId: bestOffer.buyerUserId,
              expirationTime: bestOffer.expirationTime,
              compLow: pricingSummary?.low ?? null,
              compHigh: pricingSummary?.high ?? null,
              verdict: assessment.verdict,
              verdictReason: card
                ? assessment.reason
                : `${assessment.reason} (no local card record for this listing — matched by title/image only, looser than a tracked card's full identity match)`,
            });
          }
        } catch (error) {
          entries.push({
            cardId: card?.id || null,
            offerId: listing.id || null,
            listingUrl,
            error: error.message,
          });
        }
      }
    }),
  );

  await saveBestOffersSnapshot(entries);
  return entries;
}

export function resolveCardFromSalesLine({
  cardById,
  cardBySku,
  cardByListingId,
  cardByTitle,
  cards,
  sku,
  listingId,
  itemUrl,
  title,
}) {
  const keys = [
    sku ? cardBySku.get(String(sku)) : null,
    listingId ? cardByListingId.get(String(listingId)) : null,
    itemUrl ? cardByListingId.get(String(extractEbayListingId(itemUrl))) : null,
  ];
  const cardId = keys.find(Boolean);
  if (cardId) return cardById.get(cardId) || null;

  const normalizedTitle = normalizeCardTitleText(title);
  if (normalizedTitle && cardByTitle?.has(normalizedTitle)) {
    return cardById.get(cardByTitle.get(normalizedTitle)) || null;
  }

  let bestCard = null;
  let bestScore = -1;
  let hasTie = false;
  for (const card of cards || []) {
    const score = scoreCardTitleMatch(normalizedTitle, card);
    if (score < 20) continue;
    if (score > bestScore) {
      bestCard = card;
      bestScore = score;
      hasTie = false;
      continue;
    }
    if (score === bestScore) {
      hasTie = true;
    }
  }
  return hasTie ? null : bestCard;
}

export function buildCardSalesLabel(card) {
  if (!card) return "Unmatched sale item";
  const segments = [
    card.candidateYear,
    card.candidatePlayer,
    card.candidateSetName,
    card.candidateCardNumber ? `#${card.candidateCardNumber}` : null,
    card.candidateParallel,
  ].filter(Boolean);
  return segments.join(" · ");
}

export function applySoldSaleToCard(card, sale = {}) {
  if (!card) return false;
  const normalizedAmount = normalizeSalesCurrencyValue(sale.totalAmount ?? sale.unitPrice);
  const normalizedUnitPrice = normalizeSalesCurrencyValue(sale.unitPrice ?? sale.totalAmount);
  const nextSoldAt = sale.soldAt || null;
  const nextSoldQty = Number.isFinite(sale.quantity) ? sale.quantity : 1;
  const changed = (
    card.status !== "sold" ||
    card.publishState !== "sold" ||
    card.soldAt !== nextSoldAt ||
    normalizeSalesCurrencyValue(card.soldAmount) !== normalizedAmount ||
    normalizeSalesCurrencyValue(card.soldPrice) !== normalizedUnitPrice ||
    Number(card.soldQuantity || 0) !== nextSoldQty ||
    String(card.soldOrderId || "") !== String(sale.orderId || "") ||
    String(card.soldListingId || "") !== String(sale.listingId || "")
  );
  card.status = "sold";
  card.publishState = "sold";
  card.soldAt = nextSoldAt;
  card.soldAmount = normalizedAmount;
  card.soldPrice = normalizedUnitPrice;
  card.soldQuantity = nextSoldQty;
  card.soldOrderId = sale.orderId || null;
  card.soldListingId = sale.listingId || null;
  card.soldItemUrl = sale.itemUrl || null;
  card.updatedAt = nowIso();
  return changed;
}

export function applySoldSaleToOffer(offer, sale = {}) {
  if (!offer) return false;
  const normalizedAmount = normalizeSalesCurrencyValue(sale.totalAmount ?? sale.unitPrice);
  const normalizedUnitPrice = normalizeSalesCurrencyValue(sale.unitPrice ?? sale.totalAmount);
  const nextSoldAt = sale.soldAt || null;
  const nextSoldQty = Number.isFinite(sale.quantity) ? sale.quantity : 1;
  const changed = (
    offer.status !== "sold" ||
    offer.publishState !== "sold" ||
    offer.soldAt !== nextSoldAt ||
    normalizeSalesCurrencyValue(offer.soldAmount) !== normalizedAmount ||
    normalizeSalesCurrencyValue(offer.soldPrice) !== normalizedUnitPrice ||
    Number(offer.soldQuantity || 0) !== nextSoldQty ||
    String(offer.orderId || "") !== String(sale.orderId || "") ||
    String(offer.listingId || "") !== String(sale.listingId || "")
  );
  offer.status = "sold";
  offer.publishState = "sold";
  offer.soldAt = nextSoldAt;
  offer.soldAmount = normalizedAmount;
  offer.soldPrice = normalizedUnitPrice;
  offer.soldQuantity = nextSoldQty;
  offer.orderId = sale.orderId || null;
  if (sale.listingId) offer.listingId = sale.listingId;
  if (sale.itemUrl) offer.listingUrl = sale.itemUrl;
  offer.updatedAt = nowIso();
  return changed;
}

function normalizeText(value) {
  const raw = String(value || "").trim();
  return raw ? raw : null;
}

function normalizeSportLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const key = raw.toLowerCase();
  if (key === "unmatched") return "Unmatched";
  if (
    key.includes("trading card") ||
    key.includes("non sport") ||
    key.includes("non-sport") ||
    key.includes("pokemon") ||
    key.includes("magic") ||
    key.includes("mtg") ||
    key.includes("yugioh") ||
    key.includes("yu gi oh") ||
    key.includes("star wars") ||
    key.includes("lorcana") ||
    key.includes("one piece") ||
    key.includes("digimon")
  ) {
    return "Trading Cards";
  }
  if (key.includes("ufc") || key.includes("mma") || key.includes("mixed martial")) return "MMA";
  if (key.includes("basketball") || key.includes("nba") || key.includes("hoops")) return "Basketball";
  if (key.includes("football") || key.includes("nfl") || key.includes("gridiron")) return "Football";
  if (key.includes("baseball") || key.includes("mlb") || key.includes("bowman")) return "Baseball";
  if (
    key.includes("soccer") ||
    key.includes("fifa") ||
    key.includes("uefa") ||
    key.includes("premier league") ||
    key.includes("mls")
  ) {
    return "Soccer";
  }
  if (key.includes("hockey") || key.includes("nhl")) return "Hockey";
  return "";
}

function inferSalesSport(...values) {
  for (const value of values) {
    const normalized = normalizeSportLabel(value);
    if (normalized) return normalized;
  }
  const haystack = String(values.filter(Boolean).join(" ")).toLowerCase();
  if (!haystack) return "Unmatched";
  if (/\b(nba|basketball|hoops|court kings|select basketball|prizm basketball)\b/.test(haystack)) {
    return "Basketball";
  }
  if (/\b(allen iverson)\b/.test(haystack)) {
    return "Basketball";
  }
  if (/\b(nfl|football|gridiron|score football|mosaic football|prizm football)\b/.test(haystack)) {
    return "Football";
  }
  if (/\b(mlb|baseball|bowman|stadium club|topps chrome baseball|heritage)\b/.test(haystack)) {
    return "Baseball";
  }
  if (/\b(soccer|fifa|uefa|premier league|mls|serie a|la liga|bundesliga)\b/.test(haystack)) {
    return "Soccer";
  }
  if (/\b(hockey|nhl|upper deck hockey|opc|o pee chee)\b/.test(haystack)) {
    return "Hockey";
  }
  if (/\b(ufc|mma|mixed martial)\b/.test(haystack)) {
    return "MMA";
  }
  if (
    /\b(trading card|non sport|non-sport|pokemon|magic|mtg|yugioh|yu gi oh|star wars|lorcana|one piece|digimon)\b/.test(
      haystack,
    )
  ) {
    return "Trading Cards";
  }
  return "Unmatched";
}

const AUCTION_DURATIONS = new Set([
  "DAYS_1",
  "DAYS_3",
  "DAYS_5",
  "DAYS_7",
  "DAYS_10",
  "GTC",
]);

function normalizeEbayListingMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "bin" || raw === "fixed" || raw === "buyitnow" || raw === "buy-it-now") {
    return "FIXED_PRICE";
  }
  if (raw === "auction") return "AUCTION";
  if (raw === "FIXED_PRICE" || raw === "AUCTION") return raw;
  return "FIXED_PRICE";
}

function parseOptionalMoney(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = raw.replace(/[$,\s]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeAuctionDuration(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!AUCTION_DURATIONS.has(raw)) return null;
  return raw;
}

function parseEbayListingConfigFromBody(body = {}) {
  const source = body || {};
  const patch = {};
  const has = Object.prototype.hasOwnProperty;
  if (has.call(source, "ebayListingMode") || has.call(source, "ebayListingFormat")) {
    const mode = has.call(source, "ebayListingFormat") ? source.ebayListingFormat : source.ebayListingMode;
    patch.ebayListingFormat = normalizeEbayListingMode(mode);
  }

  if (has.call(source, "ebayAuctionDuration")) {
    patch.ebayAuctionDuration =
      source.ebayAuctionDuration == null
        ? null
        : normalizeAuctionDuration(source.ebayAuctionDuration);
  }

  if (has.call(source, "ebayAuctionStartPrice")) {
    patch.ebayAuctionStartPrice = parseOptionalMoney(source.ebayAuctionStartPrice);
  }

  if (has.call(source, "ebayAuctionReservePrice")) {
    patch.ebayAuctionReservePrice = parseOptionalMoney(source.ebayAuctionReservePrice);
  }

  if (has.call(source, "ebayAuctionBuyItNowPrice")) {
    patch.ebayAuctionBuyItNowPrice = parseOptionalMoney(source.ebayAuctionBuyItNowPrice);
  }

  return patch;
}

function normalizeYear(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRookieMode(body = {}, existingCard = {}) {
  const incoming = normalizeText(body.rookieMode);
  if (incoming) return incoming;
  if (parseBoolean(body.candidateRookieFlag) || parseBoolean(body.rookieFlag)) {
    const variantLabel = normalizeText(
      body.candidateVariantLabel ||
        body.variantLabel ||
        existingCard.candidateVariantLabel ||
        existingCard.variantLabel,
    );
    return /rated rookie/i.test(variantLabel || "") ? "rated" : "generic";
  }
  return "none";
}

function normalizeAutographFlag(body = {}, existingCard = {}) {
  if (
    parseBoolean(body.autographHint ?? body.candidateAutoHint ?? existingCard.candidateAutoHint)
  ) {
    return true;
  }
  const notes = String(body.notes ?? body.candidateNotes ?? existingCard.notes ?? "");
  return /\bauto\b|\bautograph\b|\bsigned\b|\bsignature\b/i.test(notes);
}

function isRawGradeValue(value = "") {
  return ["Near Mint or Better", "Excellent", "Very Good", "Poor"].includes(String(value || "").trim());
}

function inferGradingCompany(value = "") {
  const raw = String(value || "").trim();
  const match = /^(PSA|BGS|SGC|CGC|CSG|BVG|BCCG|HGA)\b/i.exec(raw);
  return match ? match[1].toUpperCase() : null;
}

function buildReviewPatch(body = {}, existingCard = {}) {
  const rookieMode = normalizeRookieMode(body, existingCard);
  const parsedPrintRun = parsePrintRunInput(
    body.printRun ?? body.printRunValue ?? body.printRunHint ?? "",
  );
  const explicitSerial = normalizeText(
    body.serialNumber ?? body.candidateSerialNumber ?? existingCard.serialNumber,
  );
  const candidateGrade = normalizeText(body.grade ?? body.candidateGrade ?? existingCard.candidateGrade);
  const gradingCompany = normalizeText(
    body.gradingCompany ??
      body.professionalGrader ??
      existingCard.gradingCompany,
  );
  const certificationNumber = normalizeText(
    body.certificationNumber ??
      body.certificateNumber ??
      existingCard.certificationNumber,
  );
  const isGraded =
    parseBoolean(body.gradedFlag ?? body.isGraded) ||
    Boolean(gradingCompany || certificationNumber || (candidateGrade && !isRawGradeValue(candidateGrade)));
  return {
    candidatePlayer: normalizeText(
      body.playerName ?? body.candidatePlayer ?? existingCard.candidatePlayer,
    ),
    candidateSport: normalizeText(body.sport ?? body.candidateSport ?? existingCard.candidateSport) || null,
    candidateYear: normalizeYear(body.year ?? body.candidateYear ?? existingCard.candidateYear),
    candidateSetName: normalizeText(
      body.setName ?? body.candidateSetName ?? existingCard.candidateSetName,
    ),
    candidateCardNumber: normalizeText(
      body.cardNumber ?? body.candidateCardNumber ?? existingCard.candidateCardNumber,
    ),
    candidateBrand: normalizeText(
      body.brand ?? body.candidateBrand ?? existingCard.candidateBrand,
    ),
    candidateTeam: normalizeText(body.team ?? body.candidateTeam ?? existingCard.candidateTeam) || null,
    candidateLeague: normalizeText(body.league ?? body.candidateLeague ?? existingCard.candidateLeague) || null,
    mpn: normalizeText(body.mpn ?? existingCard.mpn),
    candidateParallel: normalizeText(
      body.parallel ?? body.candidateParallel ?? existingCard.candidateParallel,
    ),
    candidateBaseHint: parseBoolean(
      body.baseHint ?? body.candidateBaseHint ?? existingCard.candidateBaseHint,
    ),
    candidateAutoHint: normalizeAutographFlag(body, existingCard),
    candidateRookieFlag: rookieMode !== "none",
    candidateVariantLabel:
      rookieMode === "rated" ? "Rated Rookie" : rookieMode === "generic" ? "Rookie RC" : null,
    candidateGrade,
    gradingCompany: gradingCompany || inferGradingCompany(candidateGrade) || null,
    certificationNumber: certificationNumber || null,
    candidateCondition: isGraded
      ? "graded"
      : normalizeText(body.candidateCondition ?? existingCard.candidateCondition) ||
        existingCard.candidateCondition ||
        "raw",
    isThickCard: parseBoolean(body.thickCard ?? body.isThickCard ?? existingCard.isThickCard),
    notes: normalizeText(body.notes ?? body.candidateNotes ?? existingCard.notes) || "",
    compGradeOverride:
      normalizeText(body.compGradeOverride ?? existingCard.compGradeOverride) || null,
    compMatchMode:
      normalizeText(body.compMatchMode ?? existingCard.compMatchMode) === "strict"
        ? "strict"
        : "auto",
    serialNumber:
      explicitSerial && !parsedPrintRun.serialNumber
        ? explicitSerial
        : parsedPrintRun.serialNumber || explicitSerial || null,
    printRun: parsedPrintRun.printRun ?? existingCard.printRun ?? null,
  };
}

// Takes the ALREADY-COMPUTED patch (buildReviewPatch's output), not the raw
// request body — the review form always submits every field, whether or not
// a human actually touched it, so keying off "is this key present in the
// body" (the old behavior) marked every single field as permanently
// overridden on the very first Save, freezing it against all future
// OCR/reprocess corrections forever after. Comparing the normalized patch
// value against what the card already had is the only way to tell a real
// edit from a field that just round-tripped through the form unchanged —
// confirmed as the root cause of a card whose wrong cardNumber/autographFlag
// survived reprocessing even after the OCR itself got fixed (2026-07-04).
function buildReviewOverrideMap(patch = {}, existingCard = {}) {
  const overrides = { ...(existingCard.reviewOverrides || {}) };
  const normalizeComparable = (value) =>
    value === undefined || value === null || value === "" ? null : value;
  const booleanFields = new Set([
    "candidateBaseHint",
    "candidateAutoHint",
    "isThickCard",
    "candidateRookieFlag",
  ]);
  const mark = (key) => {
    if (booleanFields.has(key)) {
      if (Boolean(patch[key]) !== Boolean(existingCard[key])) overrides[key] = true;
      return;
    }
    if (normalizeComparable(patch[key]) !== normalizeComparable(existingCard[key])) {
      overrides[key] = true;
    }
  };
  [
    "candidatePlayer",
    "candidateSport",
    "candidateYear",
    "candidateSetName",
    "candidateCardNumber",
    "candidateParallel",
    "candidateBrand",
    "candidateTeam",
    "candidateLeague",
    "candidateGrade",
    "gradingCompany",
    "certificationNumber",
    "candidateBaseHint",
    "candidateAutoHint",
    "serialNumber",
    "printRun",
    "compGradeOverride",
    "compMatchMode",
    "isThickCard",
    "candidateRookieFlag",
  ].forEach(mark);
  return overrides;
}

function reviewPatchTouchesIdentity(body = {}) {
  return [
    "playerName",
    "candidatePlayer",
    "sport",
    "candidateSport",
    "year",
    "candidateYear",
    "setName",
    "candidateSetName",
    "cardNumber",
    "candidateCardNumber",
    "parallel",
    "candidateParallel",
    "brand",
    "candidateBrand",
    "rookieMode",
    "candidateRookieFlag",
    "baseHint",
    "candidateBaseHint",
    "autographHint",
    "candidateAutoHint",
    "grade",
    "candidateGrade",
    "gradingCompany",
    "professionalGrader",
    "certificationNumber",
    "certificateNumber",
    "gradedFlag",
    "isGraded",
    "candidateCondition",
    "serialNumber",
    "candidateSerialNumber",
    "printRun",
    "printRunValue",
    "printRunHint",
    "compGradeOverride",
    "compMatchMode",
  ].some((key) => Object.prototype.hasOwnProperty.call(body, key));
}

function clearCardProcessingCaches(card) {
  card.externalSoldComps = [];
  card.externalCompSource = null;
  card.externalCompUpdatedAt = null;
  card.externalPricingSummary = null;
  card.compMatchProvider = null;
  card.apifyLookupKey = null;
  card.apifySearchKeywords = [];
  card.apifySearchQuery = null;
  delete card.apifyError;
}

export async function handler(req, res) {
  const url = new URL(req.url, getRequestBaseUrl(req));
  const { pathname } = url;
  if (pathname.startsWith("/api/")) {
    const origin = String(req.headers.origin || "");
    if (/^https?:\/\/(?:localhost|127\.0\.0\.1):\d+$/.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
  }

  if (req.method === "GET" && pathname === "/auth/google") {
    const authUrl = getGoogleOAuthUrl(req);
    res.writeHead(302, { Location: authUrl });
    return res.end();
  }

  if (req.method === "GET" && pathname === "/auth/callback") {
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (error || !code) {
      res.writeHead(302, { Location: `/login.html?error=${encodeURIComponent(error || "No code")}` });
      return res.end();
    }
    try {
      const userInfo = await exchangeGoogleCode(req, code);
      if (!isAllowedEmail(userInfo.email)) {
        res.writeHead(302, { Location: `/login.html?error=${encodeURIComponent("Access denied")}` });
        return res.end();
      }
      setSessionCookie(res, userInfo.email);
      res.writeHead(302, { Location: "/" });
      return res.end();
    } catch (e) {
      res.writeHead(302, { Location: `/login.html?error=${encodeURIComponent(e.message)}` });
      return res.end();
    }
  }

  if (req.method === "GET" && pathname === "/auth/logout") {
    clearSessionCookie(res);
    res.writeHead(302, { Location: "/login.html" });
    return res.end();
  }

  if (req.method === "GET" && pathname === "/health") {
    return sendJson(res, 200, { ok: true });
  }

  const isPublicAsset =
    pathname === "/login.html" ||
    pathname === "/privacy.html" ||
    pathname === "/public/login.html" ||
    pathname === "/public/privacy.html" ||
    pathname === "/public/logo-badge.png" ||
    (pathname === "/public/styles.css" && !isAuthenticated(req));

  if (isPublicAsset) {
    const served = await serveStatic(req, res, pathname.replace("/public", "") || "/");
    if (served) return;
  }

  const isEbayAuthRoute =
    pathname === "/api/ebay/auth-url" || pathname === "/api/ebay/auth-callback";
  // Card images served from disk (see resolveEbayImageUrl / saveImageRecord's
  // "/files/..." fallback) need to be fetchable by eBay's own crawler and by
  // eventual buyers viewing the listing — neither has our session cookie, so
  // this route must stay outside the auth gate the same way Supabase's public
  // storage bucket already is.
  const isPublicFilesRoute = pathname.startsWith("/files/");
  const bypassesAuthGate = isEbayAuthRoute || isPublicFilesRoute;
  const authenticated = isAuthenticated(req);

  if (!authenticated && (pathname === "/" || pathname.startsWith("/public/"))) {
    const served = await serveStatic(req, res, "/login.html");
    if (served) return;
  }

  if (!authenticated && pathname.startsWith("/api/") && !bypassesAuthGate) {
    return sendJson(res, 401, { error: "Unauthorized" });
  }

  if (!authenticated && !bypassesAuthGate) {
    res.writeHead(302, { Location: "/login.html" });
    return res.end();
  }

  if (req.method === "GET" && (pathname === "/" || pathname.startsWith("/public/"))) {
    const served = await serveStatic(
      req,
      res,
      pathname === "/" ? "/" : pathname.replace("/public", ""),
    );
    if (served) return;
  }

  if (req.method === "GET" && pathname === "/api/health") {
    const apifyUsage = await getApifyUsageStatus();
    return sendJson(res, 200, {
      ok: true,
      service: "automatic-sports-card-listing",
      ebay: safeEbayHealthConfig(),
      browse: {
        hasBrowseConfig: hasBrowseConfig(),
      },
      apify: {
        hasApifyConfig: Boolean(process.env.APIFY_TOKEN),
        actorId: process.env.APIFY_EBAY_SOLD_ACTOR_ID || "caffein.dev~ebay-sold-listings",
        note: "powers both per-card sold-comp lookups and market-heat; bills per real run, see usage below",
        usage: apifyUsage,
      },
      marketDataProvider: process.env.APIFY_TOKEN ? "apify" : "none",
      openai: {
        hasVisionConfig: Boolean(process.env.OPENAI_API_KEY),
        model: process.env.OPENAI_VISION_MODEL || "gpt-4.1",
      },
    });
  }

  if (pathname.startsWith("/api/drive/")) {
    const handled = await handleDriveApiRoutes(req, res, { pathname });
    if (handled) return;
  }

  if (pathname.startsWith("/api/grading")) {
    const handled = await handleGradingApiRoutes(req, res, { pathname });
    if (handled) return;
  }

  if (pathname.startsWith("/api/dacardworld")) {
    const handled = await handleDaCardWorldApiRoutes(req, res, { pathname });
    if (handled) return;
  }

  if (req.method === "POST" && pathname === "/api/seed") {
    const count = 5;
    return withState(async (state) => {
      const batch = {
        id: createId(state, "batch"),
        source: "seed",
        notes: "Test data",
        status: "uploaded",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        publishChecklist: [
          { label: "All cards have been processed", checked: false },
          { label: "All cards have been reviewed", checked: false },
          { label: "Pricing is reasonable and consistent", checked: false },
          { label: "Comp inclusion decisions are final", checked: false },
          { label: "No critical errors in pricing evidence", checked: false },
        ],
      };
      state.batches.push(batch);
      const players = [
        "Corbin Carroll",
        "Shohei Ohtani",
        "Jackson Holliday",
        "Matas Buzelis",
        "LeBron James",
      ];
      const years = [2023, 2024, 2022, 2024, 2004];
      const sets = [
        "Topps Chrome",
        "Topps Update",
        "Bowman Chrome",
        "Panini Select",
        "Upper Deck Exquisite",
      ];
      const numbers = ["95", "US1", "BCP1", "70", "23"];
      for (let i = 0; i < count; i++) {
        const cardItemId = createId(state, "card");
        state.cardItems.push({
          id: cardItemId,
          batchId: batch.id,
          status: "needs_review",
          confidenceScore: 0.85 + Math.random() * 0.15,
          recommendedPrice: 5 + Math.random() * 50,
          currency: "USD",
          isThickCard: i % 3 === 0,
          candidateBaseHint: i % 2 === 0,
          candidateAutoHint: i % 3 === 2,
          candidatePlayer: players[i],
          candidateYear: years[i],
          candidateSetName: sets[i],
          candidateCardNumber: numbers[i],
          candidateParallel: i % 2 === 0 ? "Base" : "Blue Refractor",
          createdAt: nowIso(),
          updatedAt: nowIso(),
          publishState: "draft",
          frontImageUrl: "https://placehold.co/100x140/EEE/999?text=Card",
          sku: `${batch.id}-${cardItemId}`,
          pricingReason: `Seeded test card #${i + 1}`,
          marketDataSource: "seed",
        });
      }
      batch.status = "processing";
      batch.updatedAt = nowIso();
      createAuditEvent(state, "batch", batch.id, "seeded", { cardCount: count });
      return sendJson(res, 201, { batchId: batch.id, cardCount: count });
    });
  }

  if (pathname === "/api/ebay/auth-url" || pathname === "/api/ebay/auth-callback" ||
      pathname === "/api/ebay/refresh-token" || pathname === "/api/ebay/reset-auth" ||
      pathname === "/api/ebay/config" || pathname === "/api/ebay/setup" || pathname === "/api/ebay/auto-configure") {
    const handled = await handleEbayOAuthRoutes(req, res, { pathname, url });
    if (handled) return;
  }

  if (req.method === "POST" && pathname === "/api/ebay/generate-description") {
    const body = await readJson(req);
    const cardId = body.cardId;
    if (!cardId) return sendJson(res, 400, { error: "cardId required" });
    return withState(async (state) => {
      const card = state.cardItems.find((item) => item.id === cardId);
      if (!card) return notFound(res, "Card item not found");
      const description = await buildEBayDescriptionForCard(card);
      card.ebayDescription = description;
      card.updatedAt = nowIso();
      return sendJson(res, 200, { description, cardId });
    });
  }

  if (req.method === "POST" && pathname.match(/^\/api\/card-items\/[^/]+\/ebay-preview$/)) {
    const id = pathname.split("/")[3];
    const body = await readJson(req).catch(() => ({}));
    return withState(async (state) => {
      const card = state.cardItems.find((item) => item.id === id);
      if (!card) return notFound(res, "Card item not found");
      const force = parseBoolean(body.force) || listingPreviewLooksStale(card);
      const title = buildEBayTitleForCard(card);
      const description = await buildEBayDescriptionForCard(card, { force });
      const specifics = buildItemSpecificsForCard(card);
      card.ebayTitle = title;
      card.ebayDescription = description;
      card.ebaySpecifics = specifics;
      card.updatedAt = nowIso();
      return sendJson(res, 200, {
        cardId: id,
        title,
        description,
        specifics,
        price: card.recommendedPrice,
        condition: card.candidateCondition || "raw",
      });
    });
  }

  if (req.method === "POST" && pathname.match(/^\/api\/card-items\/[^/]+\/ebay-save$/)) {
    const id = pathname.split("/")[3];
    const body = await readJson(req);
    return withState(async (state) => {
      const card = state.cardItems.find((item) => item.id === id);
      if (!card) return notFound(res, "Card item not found");
      const listingConfig = parseEbayListingConfigFromBody(body);
      if (Object.keys(listingConfig).length > 0) {
        Object.assign(card, listingConfig);
      }
      // Was reading body.title/body.description — the only caller
      // (saveEbayListingButton in public/app.js) actually sends ebayTitle/
      // ebayDescription, so neither field was ever persisted here. The
      // frontend's optimistic local update masked this: it looked saved
      // until the next full page reload, when the un-persisted edit was
      // gone.
      if (body.ebayTitle !== undefined) card.ebayTitle = body.ebayTitle;
      if (body.ebayDescription !== undefined) card.ebayDescription = body.ebayDescription;
      if (body.specifics !== undefined) card.ebaySpecifics = body.specifics;
      // Distinct from ebaySpecifics above (a display cache overwritten by
      // every /ebay-preview call) — this is what buildItemSpecifics()
      // actually consults to let a reviewer override any item specific,
      // including the ones that are otherwise hardcoded (Type, Vintage,
      // Card Size, Material, etc.) rather than derived from OCR.
      if (body.specificsOverrides !== undefined) card.ebaySpecificsOverrides = body.specificsOverrides;
      if (body.ebayCategoryId !== undefined) card.ebayCategoryId = body.ebayCategoryId;
      if (body.recommendedPrice !== undefined) {
        card.recommendedPrice = body.recommendedPrice;
        // A human just set this price directly — the scheduled repricer's
        // +/-20% band must re-anchor to it, not keep clamping toward
        // whatever baseline it captured before this edit (which could be
        // exactly the wrong, already-drifted price this edit is fixing).
        card.repriceBaselinePrice = null;
      }
      // Absolute hard floor/ceiling the scheduled repricer can never cross,
      // regardless of its relative +/-20% band (see reprice-scheduler.js) —
      // null/blank clears the override back to "no absolute bound".
      if (body.repriceMinPrice !== undefined) {
        const parsed = normalizeSalesCurrencyValue(body.repriceMinPrice);
        card.repriceMinPrice = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      }
      if (body.repriceMaxPrice !== undefined) {
        const parsed = normalizeSalesCurrencyValue(body.repriceMaxPrice);
        card.repriceMaxPrice = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      }
      card.updatedAt = nowIso();
      return sendJson(res, 200, { ok: true });
    });
  }

  if (req.method === "GET" && pathname === "/api/bootstrap") {
    // Fetched before the lock, not inside it — getApifyUsageStatus() hits
    // Apify's own account API on a cache miss (60s TTL), and network I/O
    // should never run while holding the state lock (same discipline as
    // pipeline.js/reprice-scheduler.js's read-snapshot -> unlocked-compute
    // split).
    const apifyUsage = await getApifyUsageStatus();
    return withStateReadOnly(async (state) => {
      return sendJson(res, 200, {
        batches: state.batches.map(cleanBatch),
        cardItems: state.cardItems.map((card) =>
          cleanCard(card, state.offers.filter((offer) => offer.cardItemId === card.id))),
        // ebayOfferId included so the frontend's per-card "Publish" button
        // (canPublishOffer) can actually tell an offer was created on eBay
        // but never published — without it, that check is always false and
        // the button never renders for any card, no matter its real state.
        offers: state.offers.map((o) => ({ id: o.id, cardItemId: o.cardItemId, status: o.status, listingUrl: o.listingUrl, publishedAt: o.publishedAt, ebayOfferId: o.ebayOfferId })),
        driveFolderId: process.env.DRIVE_FOLDER_ID || "",
        gradingFeatureEnabled: isGradingFeatureEnabled(),
        apifyUsage,
      });
    });
  }

  if (req.method === "GET" && pathname === "/api/ebay/sales") {
    try {
      const days = toPositiveInt(url.searchParams.get("days"), 90);
      const startDate = url.searchParams.get("startDate") || null;
      const endDate = url.searchParams.get("endDate") || null;
      const pageSize = toPositiveInt(url.searchParams.get("pageSize"), 200);
      const maxPages = toPositiveInt(url.searchParams.get("maxPages"), 10);
      const filterSport = String(normalizeText(url.searchParams.get("sport")) || "").toLowerCase();
      const syncSales = url.searchParams.get("sync") !== "0";

      const result = await fetchEbayFulfillmentOrders({
        startDate,
        endDate,
        days,
        pageSize,
        maxPages,
      });

      return withState(async (state) => {
        const cardById = new Map((state.cardItems || []).map((card) => [card.id, card]));
        const cards = Array.isArray(state.cardItems) ? state.cardItems : [];
        const cardBySku = new Map();
        const cardByListingId = new Map();
        const cardByTitle = new Map();
        const cardImagesByCardId = new Map();
        const offerBySku = new Map();
        const offerByListingId = new Map();

        for (const offer of state.offers || []) {
          if (offer?.sku) {
            offerBySku.set(String(offer.sku), offer);
          }
          const offerListingId = offer?.listingId || extractEbayListingId(offer?.listingUrl);
          if (offerListingId) {
            offerByListingId.set(String(offerListingId), offer);
          }
          if (offer?.sku && offer?.cardItemId) {
            cardBySku.set(String(offer.sku), offer.cardItemId);
          }
          if (offerListingId && offer?.cardItemId) {
            cardByListingId.set(String(offerListingId), offer.cardItemId);
          }
        }
        for (const card of state.cardItems || []) {
          if (card?.sku) {
            cardBySku.set(String(card.sku), card.id);
          }
          const cardListingId = card?.listingId || extractEbayListingId(card?.listingUrl);
          if (cardListingId) {
            cardByListingId.set(String(cardListingId), card.id);
          }
          for (const candidate of cardTitleCandidates(card)) {
            if (!cardByTitle.has(candidate)) {
              cardByTitle.set(candidate, card.id);
            }
          }
        }
        for (const image of state.cardImages || []) {
          if (!image?.cardItemId || !image?.url) continue;
          const bucket = cardImagesByCardId.get(image.cardItemId) || { front: "", back: "", all: [] };
          if (image.side === "front" && !bucket.front) bucket.front = image.url;
          if (image.side === "back" && !bucket.back) bucket.back = image.url;
          if (!bucket.all.includes(image.url)) bucket.all.push(image.url);
          cardImagesByCardId.set(image.cardItemId, bucket);
        }

        const monthAgg = new Map();
        const matchedSalesByCardId = new Map();
        let totalUnits = 0;
        let matchedUnits = 0;
        let unmatchedUnits = 0;
        let totalAmount = 0;
        let matchedAmount = 0;
        let unmatchedAmount = 0;
        const sportBreakdown = new Map();
        let browseSaleImagesByListingId = {};

        if (hasBrowseConfig()) {
          const salesListingIds = [...new Set(
            (result.orders || [])
              .flatMap((order) => (Array.isArray(order?.lineItems) ? order.lineItems : []))
              .map((item) => lineItemListingId(item))
              .filter(Boolean),
          )];
          if (salesListingIds.length) {
            try {
              browseSaleImagesByListingId = await fetchBrowseListingImagesByLegacyId(salesListingIds);
            } catch {
              browseSaleImagesByListingId = {};
            }
          }
        }

        for (const order of result.orders || []) {
          const items = Array.isArray(order.lineItems) ? order.lineItems : [];
          for (const item of items) {
            const soldAt = normalizeOrderLineDate(order, item) || normalizeOrderDate(order);
            const monthKey = toIsoMonth(soldAt) || "unknown";
            const monthLabelValue = soldAt ? toSalesMonthLabel(soldAt) : "Unknown month";
            const monthGroup = monthAgg.get(monthKey) || {
              monthKey,
              monthLabel: monthLabelValue,
              totalUnits: 0,
              totalAmount: 0,
              sports: new Map(),
            };
            if (!monthAgg.has(monthKey)) monthAgg.set(monthKey, monthGroup);
            const quantity = lineItemQuantity(item.quantity);
            const unitPrice = lineItemPrice(item);
            const totalLinePrice = lineItemTotal(item, quantity);
            const sku = lineItemSku(item);
            const orderId = order.orderId || order.order_id || order.orderNumber || null;
            const listingId = lineItemListingId(item);
            const itemUrl = buildEbayItemUrl(listingId);
            const resolvedOffer =
              (listingId ? offerByListingId.get(String(listingId)) : null) ||
              (sku ? offerBySku.get(String(sku)) : null) ||
              null;
            const resolvedCard = resolveCardFromSalesLine({
              cardById,
              cardBySku,
              cardByListingId,
              cardByTitle,
              cards,
              sku,
              listingId,
              itemUrl,
              title: lineItemDisplayName(item),
            });
            const resolvedCardImages = resolvedCard?.id ? cardImagesByCardId.get(resolvedCard.id) : null;
            const isMatched = Boolean(resolvedCard);
            const browseListingImages = listingId ? browseSaleImagesByListingId[String(listingId)] : null;
            const matchedSport = inferSalesSport(
              resolvedCard?.candidateSport,
              resolvedCard?.sport,
              browseListingImages?.sport,
              lineItemDisplayName(item),
              sku,
            );
            if (filterSport && matchedSport.toLowerCase() !== filterSport) continue;

            const sportSummary = sportBreakdown.get(matchedSport) || {
              sport: matchedSport,
              quantity: 0,
              totalAmount: 0,
              matchedUnits: 0,
              unmatchedUnits: 0,
            };
            sportSummary.quantity += quantity;
            sportSummary.totalAmount += totalLinePrice || 0;
            if (isMatched) {
              sportSummary.matchedUnits += quantity;
            } else {
              sportSummary.unmatchedUnits += quantity;
            }
            sportBreakdown.set(matchedSport, sportSummary);

            const monthSportGroup = monthGroup.sports.get(matchedSport) || {
              sport: matchedSport,
              totalUnits: 0,
              totalAmount: 0,
              cards: new Map(),
            };
            if (!monthGroup.sports.has(matchedSport)) monthGroup.sports.set(matchedSport, monthSportGroup);

            const lineTitle =
              lineItemDisplayName(item) ||
              resolvedCard?.ebayTitle ||
              buildCardSalesLabel(resolvedCard) ||
              sku ||
              listingId ||
              orderId ||
              "Sale item";
            const saleImageUrl = pickImageUrl(
              item?.imageUrl || "",
              item?.image?.imageUrl || "",
              resolvedOffer?.imageUrl || "",
              resolvedOffer?.imageUrls || [],
              resolvedCard?.imageUrl || "",
              resolvedCardImages?.front || "",
              resolvedCardImages?.back || "",
              resolvedCardImages?.all || [],
              resolvedCard?.frontImageUrl || "",
              resolvedCard?.backImageUrl || "",
              resolvedCard?.imageUrls || [],
              browseListingImages?.imageUrl || "",
              browseListingImages?.imageUrls || [],
            );
            const cardLabel = resolvedCard ? buildCardSalesLabel(resolvedCard) : lineTitle;
            const cardKey = resolvedCard?.id || `unmatched:${listingId || sku || lineTitle || "item"}`;
            const cardEntry = monthSportGroup.cards.get(cardKey) || {
              cardId: resolvedCard?.id || null,
              cardLabel: cardLabel || lineTitle || "Unmatched sale item",
              sport: matchedSport,
              sku: sku || null,
              imageUrl: saleImageUrl || null,
              quantity: 0,
              totalAmount: 0,
              lines: [],
            };
            if (!monthSportGroup.cards.has(cardKey)) monthSportGroup.cards.set(cardKey, cardEntry);
            if (!cardEntry.imageUrl && saleImageUrl) cardEntry.imageUrl = saleImageUrl;

            cardEntry.quantity += quantity;
            cardEntry.totalAmount += totalLinePrice || 0;
            cardEntry.lines.push({
              orderId,
              listingId,
              soldAt,
              sku,
              soldQty: quantity,
              unitPrice: unitPrice != null ? unitPrice : null,
              totalPrice: totalLinePrice,
              lineTitle,
              itemUrl,
              sellerOrderUrl: buildEbaySellerOrderUrl(orderId),
            });

            monthSportGroup.totalUnits += quantity;
            monthSportGroup.totalAmount += totalLinePrice || 0;
            monthGroup.totalUnits += quantity;
            monthGroup.totalAmount += totalLinePrice || 0;
            totalUnits += quantity;
            if (isMatched) {
              matchedUnits += quantity;
              matchedAmount += totalLinePrice || 0;
              const existingSale = matchedSalesByCardId.get(resolvedCard.id) || {
                soldAt: null,
                quantity: 0,
                totalAmount: 0,
                unitPrice: null,
                orderId: null,
                listingId: null,
                itemUrl: null,
              };
              existingSale.quantity += quantity;
              existingSale.totalAmount += totalLinePrice || 0;
              existingSale.unitPrice = unitPrice != null ? unitPrice : existingSale.unitPrice;
              if (!existingSale.soldAt || (soldAt && soldAt > existingSale.soldAt)) {
                existingSale.soldAt = soldAt || existingSale.soldAt;
                existingSale.orderId = orderId;
                existingSale.listingId = listingId;
                existingSale.itemUrl = itemUrl;
              }
              matchedSalesByCardId.set(resolvedCard.id, existingSale);
            } else {
              unmatchedUnits += quantity;
              unmatchedAmount += totalLinePrice || 0;
            }
            totalAmount += totalLinePrice || 0;
          }
        }

        let syncedCards = 0;
        let syncedOffers = 0;
        if (syncSales) {
          for (const [cardId, sale] of matchedSalesByCardId.entries()) {
            const resolvedCard = cardById.get(cardId);
            if (!resolvedCard) continue;
            const cardChanged = applySoldSaleToCard(resolvedCard, sale);
            if (cardChanged) {
              syncedCards += 1;
              createAuditEvent(state, "cardItem", resolvedCard.id, "sold_synced_from_ebay", {
                soldAt: sale.soldAt || null,
                soldAmount: normalizeSalesCurrencyValue(sale.totalAmount),
                soldPrice: normalizeSalesCurrencyValue(sale.unitPrice),
                soldQuantity: sale.quantity || 0,
                orderId: sale.orderId || null,
                listingId: sale.listingId || null,
              });
            }
            for (const offer of state.offers || []) {
              const matchesCard = offer?.cardItemId === resolvedCard.id;
              const matchesListing = sale.listingId && String(offer?.listingId || "") === String(sale.listingId);
              const matchesSku = resolvedCard.sku && String(offer?.sku || "") === String(resolvedCard.sku);
              if (!matchesCard && !matchesListing && !matchesSku) continue;
              if (applySoldSaleToOffer(offer, sale)) syncedOffers += 1;
            }
          }
        }

        const grouped = [...monthAgg.values()]
          .map((monthGroup) => ({
            monthKey: monthGroup.monthKey || "unknown",
            monthLabel: monthGroup.monthLabel || "Unknown month",
            quantity: monthGroup.totalUnits,
            totalAmount: normalizeSalesCurrencyValue(monthGroup.totalAmount),
            sports: [...monthGroup.sports.values()]
              .map((sportGroup) => ({
                sport: sportGroup.sport,
                quantity: sportGroup.totalUnits,
                totalAmount: normalizeSalesCurrencyValue(sportGroup.totalAmount),
                cards: [...sportGroup.cards.values()]
                  .map((entry) => ({
                    cardId: entry.cardId,
                    cardLabel: entry.cardLabel || "Unmatched sale item",
                    sport: entry.sport,
                    sku: entry.sku,
                    imageUrl: entry.imageUrl || null,
                    quantity: entry.quantity,
                    totalAmount: normalizeSalesCurrencyValue(entry.totalAmount),
                    lines: entry.lines,
                  }))
                  .sort((a, b) => (b.totalAmount || 0) - (a.totalAmount || 0)),
              }))
              .sort((a, b) => (b.totalAmount || 0) - (a.totalAmount || 0)),
          }))
          .sort((a, b) => (b.monthKey || "").localeCompare(a.monthKey || ""));

        return sendJson(res, 200, {
          dateRange: result.dateRange,
          summary: {
            totalOrders: result.totalFound,
            totalUnits,
            matchedUnits,
            unmatchedUnits,
            totalAmount: normalizeSalesCurrencyValue(totalAmount),
            matchedAmount: normalizeSalesCurrencyValue(matchedAmount),
            unmatchedAmount: normalizeSalesCurrencyValue(unmatchedAmount),
            syncedCards,
            syncedOffers,
          },
          sportBreakdown: [...sportBreakdown.values()]
            .map((entry) => ({
              sport: entry.sport,
              quantity: entry.quantity,
              totalAmount: normalizeSalesCurrencyValue(entry.totalAmount),
              matchedUnits: entry.matchedUnits,
              unmatchedUnits: entry.unmatchedUnits,
            }))
            .sort((a, b) => (b.totalAmount || 0) - (a.totalAmount || 0)),
          groups: grouped,
        });
      });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "GET" && pathname === "/api/ebay/market-heat") {
    try {
      const days = toPositiveInt(url.searchParams.get("days"), 7);
      const sampleSize = toPositiveInt(url.searchParams.get("sampleSize"), 500);
      const limitPlayers = toPositiveInt(url.searchParams.get("limitPlayers"), 50);
      const sport = String(url.searchParams.get("sport") || "all").trim().toLowerCase();
      const refresh =
        String(url.searchParams.get("refresh") || "").trim() === "1" ||
        String(url.searchParams.get("refresh") || "").trim().toLowerCase() === "true";

      const report = await getApifyMarketHeatReport({
        days,
        sampleSize,
        limitPlayers,
        sport,
        refresh,
      });

      return sendJson(res, 200, report);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "GET" && pathname === "/api/ebay/market-heat/player-insight") {
    try {
      const mode = "comps";
      const playerName = String(url.searchParams.get("player") || "").trim();
      const sport = String(url.searchParams.get("sport") || "").trim();
      const count = toPositiveInt(url.searchParams.get("count"), 20);
      if (!playerName) {
        throw new Error("Player name is required.");
      }

      const metadata = {
        playerName,
        sport,
        compMatchMode: "auto",
      };

      const result = await searchApifySoldListings(metadata);
      const comps = Array.isArray(result?.comps)
        ? result.comps.slice(0, Math.min(Math.max(count, 1), 50))
        : [];
      return sendJson(res, 200, {
        ...result,
        mode,
        playerName,
        sport,
        comps,
        loadedCount: comps.length,
      });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "GET" && pathname === "/api/ebay/listings") {
    try {
      const salesDays = toPositiveInt(url.searchParams.get("salesDays"), 90);
      const pageSize = Math.max(1, Math.min(100, toPositiveInt(url.searchParams.get("pageSize"), 100)));
      const maxPages = toPositiveInt(url.searchParams.get("maxPages"), 5);
      const filterSport = String(normalizeText(url.searchParams.get("sport")) || "").toLowerCase();
      const searchText = String(normalizeText(url.searchParams.get("search")) || "").toLowerCase();
      const ageFilter = String(url.searchParams.get("ageFilter") || "").trim();
      const sort = String(url.searchParams.get("sort") || "daysDesc");
      const snapshot = await getState();
      const trackedOffers = [
        ...(Array.isArray(snapshot.offers) ? snapshot.offers : []),
        ...buildTrackedOffersFromCards(snapshot.cardItems || []),
      ];

      const liveListingsTimeoutMs = Math.max(
        3000,
        Math.min(30000, Number.parseInt(process.env.EBAY_ACTIVE_LISTINGS_TIMEOUT_MS || "30000", 10) || 30000),
      );
      const salesTimeoutMs = Math.max(
        3000,
        Math.min(30000, Number.parseInt(process.env.EBAY_SALES_ANALYTICS_TIMEOUT_MS || "12000", 10) || 12000),
      );
      const [salesResult, activeListingsResult] = await Promise.allSettled([
        withTimeout(
          fetchEbayFulfillmentOrders({ days: salesDays, pageSize: 100, maxPages: 10 }),
          salesTimeoutMs,
          "Sales analytics",
        ),
        withTimeout(
          fetchEbayActiveListings({
            offers: trackedOffers,
            pageSize,
            maxPages,
          }),
          liveListingsTimeoutMs,
          "Active listings",
        ).catch((error) => {
          if (isEbayAuthFailure(error)) throw error;
          console.warn("Active listings live fetch fell back to tracked offers:", error.message);
          return fetchEbayActiveListings({
            offers: trackedOffers,
            pageSize,
            maxPages,
            live: false,
          });
        }),
      ]);
      if (activeListingsResult.status !== "fulfilled") {
        throw activeListingsResult.reason;
      }
      let activeListings = activeListingsResult.value;
      if (!activeListings.length && trackedOffers.length) {
        console.warn("Active listings live fetch returned zero; falling back to tracked offers.");
        activeListings = await fetchEbayActiveListings({
          offers: trackedOffers,
          pageSize,
          maxPages,
          live: false,
        });
      }
      const salesData =
        salesResult.status === "fulfilled"
          ? salesResult.value
          : { orders: [], totalFound: 0, dateRange: null };
      const analyticsError =
        salesResult.status === "rejected"
          ? salesResult.reason?.message || "Sales analytics unavailable."
          : null;

      const state = snapshot;
      const cardById = new Map((state.cardItems || []).map((card) => [card.id, card]));
      const cards = Array.isArray(state.cardItems) ? state.cardItems : [];
      const cardBySku = new Map();
      const cardByListingId = new Map();
      const offerBySku = new Map();
      const offerByListingId = new Map();
      const cardByTitle = new Map();
      const compsByCardId = buildExternalCompsByCardId(state);
      const perLoadOfferHydrationLimit = Math.max(
        0,
        Math.min(50, toPositiveInt(process.env.SOLDCOMPS_REPRICE_SCHEDULES_PER_LOAD, 12)),
      );
      let scheduledOfferHydrations = 0;
      const touchedOfferIds = new Set();
      const touchedCardIds = new Set();

      for (const offer of state.offers || []) {
        if (offer?.sku && offer?.cardItemId) {
          cardBySku.set(String(offer.sku), offer.cardItemId);
        }
        if (offer?.sku) {
          offerBySku.set(String(offer.sku), offer);
        }
        const offerListingId = offer?.listingId || extractEbayListingId(offer?.listingUrl);
        if (offerListingId && offer?.cardItemId) {
          cardByListingId.set(String(offerListingId), offer.cardItemId);
        }
        if (offerListingId) {
          offerByListingId.set(String(offerListingId), offer);
        }
      }

      for (const card of state.cardItems || []) {
        if (card?.sku) {
          cardBySku.set(String(card.sku), card.id);
        }
        const cardListingId = card?.listingId || extractEbayListingId(card?.listingUrl);
        if (cardListingId) {
          cardByListingId.set(String(cardListingId), card.id);
        }
        for (const candidate of cardTitleCandidates(card)) {
          if (!cardByTitle.has(candidate)) {
            cardByTitle.set(candidate, card.id);
          }
        }
      }

      const salesAgg = new Map();
      let accountSoldUnitsInWindow = 0;
      let accountSoldRevenueInWindow = 0;
      for (const order of salesData.orders || []) {
        const items = Array.isArray(order.lineItems) ? order.lineItems : [];
        for (const item of items) {
          const listingId = lineItemListingId(item);
          const sku = lineItemSku(item);
          const soldAt = normalizeOrderLineDate(order, item) || normalizeOrderDate(order);
          const quantity = lineItemQuantity(item.quantity);
          const totalPrice = lineItemTotal(item, quantity) || 0;
          accountSoldUnitsInWindow += quantity;
          accountSoldRevenueInWindow += totalPrice;
          const resolvedCard = resolveCardFromSalesLine({
            cardById,
            cardBySku,
            cardByListingId,
            cardByTitle,
            cards,
            sku,
            listingId,
            itemUrl: buildEbayItemUrl(listingId),
            title: lineItemDisplayName(item),
          });
          const keys = [
            listingAnalyticsKey(listingId, null),
            listingAnalyticsKey(null, sku),
            listingCardAnalyticsKey(resolvedCard?.id),
          ].filter(Boolean);

          for (const key of keys) {
            const existing = salesAgg.get(key) || {
              soldUnits: 0,
              totalRevenue: 0,
              lastSaleAt: null,
            };
            existing.soldUnits += quantity;
            existing.totalRevenue += totalPrice;
            if (soldAt && (!existing.lastSaleAt || soldAt > existing.lastSaleAt)) {
              existing.lastSaleAt = soldAt;
            }
            salesAgg.set(key, existing);
          }
        }
      }

      let browseListingDates = {};
      if (hasBrowseConfig()) {
        const missingListingIds = activeListings
          .filter((listing) => !listing?.listedAt && listing?.listingId)
          .map((listing) => listing.listingId);
        if (missingListingIds.length) {
          try {
            browseListingDates = await fetchBrowseListingDatesByLegacyId(missingListingIds);
          } catch {
            browseListingDates = {};
          }
        }
      }

      const buildRepricingSignal = (card, offer, currentPrice) => {
        const pricingSummary = offer?.externalPricingSummary || card?.externalPricingSummary || null;
        const recommendedPrice = normalizeSalesCurrencyValue(card?.recommendedPrice);
        const source = pricingSummary?.source || (pricingSummary ? "soldcomps" : "recommended");
        const rawTarget = pricingSummary?.compPrice ?? recommendedPrice;
        const targetPrice = normalizeSalesCurrencyValue(rawTarget);
        let low = normalizeSalesCurrencyValue(pricingSummary?.low);
        let high = normalizeSalesCurrencyValue(pricingSummary?.high);

        const hasMeaningfulTarget = Number.isFinite(targetPrice) && targetPrice > 0;
        const hasMeaningfulRange =
          (Number.isFinite(low) && low > 0) || (Number.isFinite(high) && high > 0);

        if (!hasMeaningfulTarget && !hasMeaningfulRange) {
          return {
            status: "unavailable",
            source,
            targetPrice: null,
            low: null,
            high: null,
            deltaAmount: null,
            deltaPct: null,
          };
        }

        if (!Number.isFinite(low) && hasMeaningfulTarget) {
          low = normalizeSalesCurrencyValue(targetPrice * 0.9);
        }
        if (!Number.isFinite(high) && hasMeaningfulTarget) {
          high = normalizeSalesCurrencyValue(targetPrice * 1.1);
        }

        if (!hasMeaningfulTarget || !Number.isFinite(currentPrice)) {
          return {
            status: "unavailable",
            source,
            targetPrice: hasMeaningfulTarget ? targetPrice : null,
            low: Number.isFinite(low) && low > 0 ? low : null,
            high: Number.isFinite(high) && high > 0 ? high : null,
            deltaAmount: null,
            deltaPct: null,
          };
        }

        const deltaAmount = normalizeSalesCurrencyValue(currentPrice - targetPrice) || 0;
        const deltaPct = targetPrice ? deltaAmount / targetPrice : null;
        let status = "aligned";

        if (
          (Number.isFinite(high) && currentPrice > high) ||
          (Number.isFinite(deltaPct) && deltaPct >= 0.15)
        ) {
          status = "overpriced";
        } else if (
          (Number.isFinite(low) && currentPrice < low) ||
          (Number.isFinite(deltaPct) && deltaPct <= -0.15)
        ) {
          status = "underpriced";
        }

        return {
          status,
          source,
          targetPrice,
          low: Number.isFinite(low) ? low : null,
          high: Number.isFinite(high) ? high : null,
          deltaAmount,
          deltaPct: Number.isFinite(deltaPct) ? deltaPct : null,
        };
      };

      const listings = [];
      for (const listing of activeListings) {
        const resolvedOffer = ensureTrackedOfferForListing(
          state,
          { offerBySku, offerByListingId },
          listing,
        );
        if (resolvedOffer?.id) {
          touchedOfferIds.add(resolvedOffer.id);
        }
        const resolvedCard = resolveCardFromSalesLine({
          cardById,
          cardBySku,
          cardByListingId,
          cardByTitle,
          cards,
          sku: listing.sku,
          listingId: listing.listingId,
          itemUrl: listing.listingUrl,
          title: listing.title,
        });
        const stableListingTitle = String(
          listing.title ||
          resolvedOffer?.ebayTitle ||
          resolvedOffer?.title ||
          resolvedCard?.ebayTitle ||
          "",
        ).trim();
        const listingImageUrl = pickImageUrl(
          listing.imageUrl,
          listing.imageUrls,
          resolvedOffer?.imageUrl,
          resolvedOffer?.imageUrls,
          resolvedCard?.frontImageUrl,
          resolvedCard?.backImageUrl,
          resolvedCard?.imageUrl,
          resolvedCard?.imageUrls,
        );
        rememberCardEbayTitle(resolvedCard, stableListingTitle);
        rememberOfferEbayTitle(resolvedOffer, stableListingTitle);
        ensureExternalPricingSummary(resolvedCard, compsByCardId);
        const offerLookupMetadata = resolvedOffer
          ? buildOfferExternalCompLookupMetadata(resolvedOffer, stableListingTitle, listingImageUrl)
          : null;
        const cardLookupMetadata = resolvedCard
          ? buildExternalCompLookupMetadata(
            resolvedCard,
            stableListingTitle || resolvedCard?.ebayTitle || "",
            listingImageUrl,
          )
          : null;
        if (resolvedCard?.id) {
          touchedCardIds.add(resolvedCard.id);
        }
        void offerLookupMetadata;
        void cardLookupMetadata;
        const sport = String(normalizeText(resolvedCard?.candidateSport) || "Unmatched");
        if (filterSport && sport.toLowerCase() !== filterSport) continue;

        const searchHaystack = [
          stableListingTitle,
          listing.sku,
          listing.listingId,
          resolvedCard?.candidatePlayer,
          resolvedCard?.candidateSetName,
          resolvedCard?.candidateCardNumber,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (searchText && !searchHaystack.includes(searchText)) continue;

        const listingMetrics =
          salesAgg.get(listingAnalyticsKey(listing.listingId, null)) ||
          salesAgg.get(listingAnalyticsKey(null, listing.sku)) ||
          salesAgg.get(listingCardAnalyticsKey(resolvedCard?.id)) ||
          null;
        const listedAt =
          listing.listedAt ||
          browseListingDates[String(listing.listingId)] ||
          resolvedCard?.publishedAt ||
          resolvedCard?.updatedAt ||
          resolvedCard?.createdAt ||
          null;
        const daysListed = toDaysListed(listedAt);
        if (!matchesListingAgeFilter(daysListed, ageFilter)) continue;
        const currentPrice = normalizeSalesCurrencyValue(listing.currentPrice);
        const soldUnits = listingMetrics?.soldUnits || 0;
        const soldRevenue = normalizeSalesCurrencyValue(listingMetrics?.totalRevenue || 0) || 0;
        const repricing = buildRepricingSignal(resolvedCard, resolvedOffer, currentPrice);

        listings.push({
          offerId: listing.offerId,
          listingId: listing.listingId,
          listingUrl: listing.listingUrl,
          imageUrl: listingImageUrl || null,
          title:
            stableListingTitle ||
            resolvedCard?.ebayTitle ||
            buildCardSalesLabel(resolvedCard) ||
            listing.sku ||
            listing.offerId ||
            "Untitled listing",
          cardId: resolvedCard?.id || null,
          sport,
          format: listing.format || "FIXED_PRICE",
          status: listing.status || "UNKNOWN",
          sku: listing.sku || null,
          currentPrice,
          listedAt,
          daysListed,
          quantity: listing.quantity,
          bestOfferEnabled: Boolean(listing.bestOfferEnabled),
          recommendedPrice: normalizeSalesCurrencyValue(resolvedCard?.recommendedPrice),
          externalCompSource: resolvedCard?.externalCompSource || null,
          repricing,
          analytics: {
            soldUnits,
            totalRevenue: soldRevenue,
            lastSaleAt: listingMetrics?.lastSaleAt || null,
            soldQuantity: listing.soldQuantity,
            watchCount: listing.watchCount,
            impressionCount: listing.impressionCount,
          },
        });
      }

      listings.sort((a, b) => {
        const aDays = Number.isFinite(a.daysListed) ? a.daysListed : -1;
        const bDays = Number.isFinite(b.daysListed) ? b.daysListed : -1;
        if (sort === "recent") return (b.listedAt || "").localeCompare(a.listedAt || "");
        if (sort === "priceDesc") return (b.currentPrice || 0) - (a.currentPrice || 0);
        if (sort === "priceAsc") return (a.currentPrice || 0) - (b.currentPrice || 0);
        if (sort === "salesDesc") return (b.analytics?.totalRevenue || 0) - (a.analytics?.totalRevenue || 0);
        if (bDays !== aDays) return bDays - aDays;
        return (b.listedAt || "").localeCompare(a.listedAt || "");
      });

      const totalValue = listings.reduce((sum, listing) => {
        const quantity = Number.isFinite(listing.quantity) ? listing.quantity : 1;
        return sum + ((listing.currentPrice || 0) * Math.max(quantity, 1));
      }, 0);
      const averageDaysListed =
        listings.length
          ? Math.round(
              listings.reduce((sum, listing) => sum + (listing.daysListed || 0), 0) / listings.length,
            )
          : 0;
      const withBestOffer = listings.filter((listing) => listing.bestOfferEnabled).length;
      const soldUnitsInWindow = listings.reduce((sum, listing) => sum + (listing.analytics?.soldUnits || 0), 0);
      const soldRevenueInWindow = listings.reduce(
        (sum, listing) => sum + (listing.analytics?.totalRevenue || 0),
        0,
      );
      const repricingCounts = listings.reduce((counts, listing) => {
        const status = listing?.repricing?.status || "unavailable";
        if (!Object.prototype.hasOwnProperty.call(counts, status)) {
          counts.unavailable += 1;
          return counts;
        }
        counts[status] += 1;
        return counts;
      }, {
        overpriced: 0,
        underpriced: 0,
        aligned: 0,
        unavailable: 0,
      });

      return sendJson(res, 200, {
        analyticsError,
        analyticsWindowDays: salesDays,
        ageFilter,
        externalRepriceQueue: {
          ...getExternalRepriceQueueStatus(),
          scheduledThisLoad: scheduledOfferHydrations,
          perLoadLimit: perLoadOfferHydrationLimit,
        },
        summary: {
          totalListings: listings.length,
          totalValue: normalizeSalesCurrencyValue(totalValue),
          averageDaysListed,
          withBestOffer,
          accountSalesOrdersInWindow: salesData.totalFound || 0,
          accountSoldUnitsInWindow,
          accountSoldRevenueInWindow: normalizeSalesCurrencyValue(accountSoldRevenueInWindow),
          soldUnitsInWindow,
          soldRevenueInWindow: normalizeSalesCurrencyValue(soldRevenueInWindow),
          repricingCounts,
          repricingActionable: repricingCounts.overpriced + repricingCounts.underpriced,
        },
        listings,
      });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && pathname === "/api/ebay/listings/update-price") {
    const body = await readJson(req);
    return withState(async (state) => {
      const result = await updateEbayListingPrice({
        offerId: body.listingId ? null : body.offerId || null,
        sku: body.sku || null,
        listingId: body.listingId || null,
        format: body.format || "FIXED_PRICE",
        price: body.price,
      });

      const matchingOffer = (state.offers || []).find((offer) =>
        (result.listingId && offer.listingId === result.listingId) ||
        (result.offerId && offer.ebayOfferId === result.offerId) ||
        (result.sku && offer.sku === result.sku),
      );
      if (matchingOffer) {
        matchingOffer.price = Number(body.price);
        matchingOffer.updatedAt = nowIso();
      }

      const matchingCard = (state.cardItems || []).find((card) =>
        (result.listingId && card.listingId === result.listingId) ||
        (result.sku && card.sku === result.sku),
      );
      if (matchingCard) {
        matchingCard.recommendedPrice = Number(body.price);
        // Same reasoning as the ebay-save route: a human just pushed this
        // price live, so the scheduler must re-anchor to it rather than
        // clamping future cycles toward whatever baseline predates this fix.
        matchingCard.repriceBaselinePrice = null;
        matchingCard.updatedAt = nowIso();
      }

      createAuditEvent(
        state,
        "offer",
        matchingOffer?.id || result.offerId || result.listingId || result.sku,
        "price_updated",
        {
          listingId: result.listingId,
          sku: result.sku,
          price: Number(body.price),
        },
      );

      return sendJson(res, 200, { listing: result });
    });
  }

  if (req.method === "GET" && pathname === "/api/best-offers") {
    const snapshot = await getBestOffersSnapshot();
    return sendJson(res, 200, snapshot);
  }

  if (req.method === "POST" && pathname === "/api/best-offers/refresh") {
    if (bestOffersRefreshInProgress) {
      return sendJson(res, 409, { error: "A Best Offers refresh is already in progress — try again shortly." });
    }
    bestOffersRefreshInProgress = true;
    sendJson(res, 202, { ok: true, message: "Refresh started" });
    refreshBestOffers()
      .catch((error) => console.error("[best-offers] refresh failed:", error.message))
      .finally(() => {
        bestOffersRefreshInProgress = false;
      });
    return;
  }

  if (req.method === "POST" && pathname === "/api/best-offers/respond") {
    const body = await readJson(req);
    const itemId = extractItemIdFromListingUrl(body.listingUrl) || String(body.itemId || "").trim();
    const bestOfferId = String(body.bestOfferId || "").trim();
    const action = String(body.action || "").trim();
    const counterOfferPrice = normalizeSalesCurrencyValue(body.counterOfferPrice);
    try {
      await respondToBestOffer({
        itemId,
        bestOfferId,
        action,
        counterOfferPrice,
        sellerResponse: body.sellerResponse || "",
      });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
    // Drop the responded-to offer from the cached snapshot immediately so
    // the UI reflects it without waiting for (or spending) a full refresh
    // cycle's worth of live Trading API + comp-lookup calls.
    const snapshot = await getBestOffersSnapshot();
    const respondedEntry = (snapshot.entries || []).find((entry) => entry.bestOfferId === bestOfferId);
    const remaining = (snapshot.entries || []).filter((entry) => entry.bestOfferId !== bestOfferId);
    await saveBestOffersSnapshot(remaining);
    if (respondedEntry?.cardId) {
      await withState(async (state) => {
        createAuditEvent(state, "cardItem", respondedEntry.cardId, "best_offer_response", {
          offerId: respondedEntry.offerId,
          bestOfferId,
          action,
          offerAmount: respondedEntry.offerAmount,
          counterOfferPrice: action === "Counter" ? counterOfferPrice : null,
        });
      });
    }
    return sendJson(res, 200, { ok: true, action });
  }

  if (req.method === "POST" && pathname === "/api/ebay/listings/reprice") {
    const body = await readJson(req);
    if (!hasApifyConfig()) {
      return sendJson(res, 400, { error: "APIFY_TOKEN is not configured." });
    }

    const listingId = String(body.listingId || "").trim();
    const sku = String(body.sku || "").trim();
    const offerId = String(body.offerId || "").trim();
    const cardId = String(body.cardId || "").trim();
    const titleHint = String(body.title || "").trim();
    const currentPrice = normalizeSalesCurrencyValue(body.currentPrice);

    const snapshot = await getState();
    const findMatchingOffer = (offers = []) =>
      (listingId ? offers.find((offer) => String(offer?.listingId || "") === listingId) : null) ||
      (offerId ? offers.find((offer) => String(offer?.ebayOfferId || "") === offerId) : null) ||
      (sku ? offers.find((offer) => String(offer?.sku || "") === sku) : null) ||
      null;
    const findMatchingCard = (cards = [], linkedOffer = null) =>
      (cardId ? cards.find((card) => String(card?.id || "") === cardId) : null) ||
      (linkedOffer?.cardItemId
        ? cards.find((card) => String(card?.id || "") === String(linkedOffer.cardItemId))
        : null) ||
      (listingId ? cards.find((card) => String(card?.listingId || "") === listingId) : null) ||
      (sku ? cards.find((card) => String(card?.sku || "") === sku) : null) ||
      null;

    const matchingOffer = findMatchingOffer(snapshot.offers || []);
    const matchingCard = findMatchingCard(snapshot.cardItems || [], matchingOffer);

    if (!matchingOffer && !matchingCard) {
      return sendJson(res, 404, { error: "Listing is not linked to a tracked card yet." });
    }

    const manualLookupTimeoutMs = Math.max(
      5000,
      Math.min(
        45000,
        toPositiveInt(
          process.env.SOLDCOMPS_MANUAL_REPRICE_TIMEOUT_MS,
          toPositiveInt(process.env.SOLDCOMPS_REPRICE_LOOKUP_TIMEOUT_MS, 30000),
        ),
      ),
    );


    let lookupSource = null;
    let offerLookupError = null;
    let cardMatch = null;
    let cardMatchWarning = null;
    const imageUrl = pickImageUrl(
      body.imageUrl || "",
      matchingOffer?.imageUrl || "",
      matchingCard?.frontImageUrl || "",
      matchingCard?.backImageUrl || "",
    );
    const eBayLookupMetadata = matchingCard
      ? buildExternalCompLookupMetadata(
          matchingCard,
          titleHint || matchingOffer?.ebayTitle || "",
          imageUrl,
        )
      : buildOfferExternalCompLookupMetadata(
          matchingOffer,
          titleHint || matchingCard?.ebayTitle || "",
          imageUrl,
        );
    const lookupResult = await withTimeout(
      getLiveCardComps(
        eBayLookupMetadata,
        null,
        null,
        null,
        matchingCard?.externalSoldComps || [],
        imageUrl,
      ),
      manualLookupTimeoutMs,
      "eBay image search sold comp lookup",
    );
    lookupSource = "ebay_image_search";
    const summaryRecord = matchingCard || matchingOffer || {};
    const eBaySummary = buildEbayPricingSummary(summaryRecord, lookupResult.sold, lookupResult.active);
    const topMatchedListing = lookupResult.active[0] || lookupResult.sold[0] || null;
    cardMatch = topMatchedListing
      ? {
          description: topMatchedListing.title || null,
          matchedVia: imageUrl ? "ebay-search-by-image" : "ebay-keyword-search",
          score: topMatchedListing.matchScore ?? null,
        }
      : null;
    cardMatchWarning = lookupResult.sold.length ? null : "eBay image search did not find sold comps.";

    if (matchingOffer) {
      if (imageUrl && !matchingOffer.imageUrl) {
        matchingOffer.imageUrl = imageUrl;
      }
      matchingOffer.externalCompLookupAttemptedAt = nowIso();
      rememberOfferEbayTitle(matchingOffer, eBayLookupMetadata.titleHint);
      matchingOffer.externalCompSource = "ebay_image_search";
      matchingOffer.externalCompMatch = cardMatch;
      matchingOffer.externalCompMatchWarning = cardMatchWarning;
      matchingOffer.externalPricingSummary = eBaySummary;
      matchingOffer.externalCompUpdatedAt = nowIso();
      matchingOffer.updatedAt = nowIso();
      delete matchingOffer.apifyError;
    }

    if (matchingCard) {
      matchingCard.externalCompLookupAttemptedAt = nowIso();
      matchingCard.externalSoldComps = Array.isArray(lookupResult.sold) ? lookupResult.sold.slice(0, 50) : [];
      matchingCard.externalCompSource = "ebay_image_search";
      matchingCard.externalCompMatch = cardMatch;
      matchingCard.externalCompMatchWarning = cardMatchWarning;
      matchingCard.externalPricingSummary = eBaySummary;
      matchingCard.externalCompUpdatedAt = nowIso();
      matchingCard.updatedAt = nowIso();
      delete matchingCard.apifyError;
    }

    const repricing = buildManualRepricingSignal(matchingCard, matchingOffer, currentPrice);
    const targetLabel = Number.isFinite(repricing.targetPrice) ? `$${repricing.targetPrice.toFixed(2)}` : "No target";
    const rangeLabel =
      Number.isFinite(repricing.low) && Number.isFinite(repricing.high)
        ? `$${repricing.low.toFixed(2)} - $${repricing.high.toFixed(2)}`
        : Number.isFinite(repricing.low)
          ? `From $${repricing.low.toFixed(2)}`
          : Number.isFinite(repricing.high)
            ? `Up to $${repricing.high.toFixed(2)}`
            : "No range";

    const offerPatch = matchingOffer ? { ...matchingOffer } : null;
    const cardPatch = matchingCard ? { ...matchingCard } : null;

    await withState(async (state) => {
      let liveOffer = null;
      if (offerPatch) {
        liveOffer = findMatchingOffer(state.offers || []);
        if (liveOffer) Object.assign(liveOffer, offerPatch);
      }

      let liveCard = null;
      if (cardPatch) {
        liveCard = findMatchingCard(state.cardItems || [], liveOffer);
        if (liveCard) Object.assign(liveCard, cardPatch);
      }

      createAuditEvent(
        state,
        "offer",
        liveOffer?.id || liveCard?.id || listingId || sku || offerId || "manual_reprice",
        "ebay_image_manual_reprice",
        {
          listingId: listingId || null,
          sku: sku || null,
          offerId: offerId || null,
          cardId: liveCard?.id || cardPatch?.id || null,
          source: lookupSource,
          repricing,
        },
      );
    });

    return sendJson(res, 200, {
      listingId: listingId || matchingOffer?.listingId || matchingCard?.listingId || null,
      cardId: matchingCard?.id || null,
      source: lookupSource,
      repricing,
      cardMatch,
      cardMatchWarning,
      message:
        repricing.status === "unavailable"
          ? offerLookupError
            ? `eBay image search timed out before pricing finished. ${rangeLabel}.`
            : `eBay image search finished, but no target was returned yet. ${rangeLabel}.`
          : `eBay image target ${targetLabel} (${rangeLabel}).`,
    });
  }

  if (req.method === "POST" && pathname === "/api/batches") {
    const body = await readJson(req);
    return withState(async (state) => {
      const batch = {
        id: createId(state, "batch"),
        source: body.source || "web",
        notes: body.notes || "",
        status: "uploaded",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        publishChecklist: [
          { label: "All cards have been processed", checked: false },
          { label: "All cards have been reviewed", checked: false },
          { label: "Pricing is reasonable and consistent", checked: false },
          { label: "Comp inclusion decisions are final", checked: false },
          { label: "No critical errors in pricing evidence", checked: false },
        ],
      };
      state.batches.push(batch);
      createAuditEvent(state, "batch", batch.id, "created", body);
      return sendJson(res, 201, batch);
    });
  }

  if (req.method === "GET" && pathname.startsWith("/api/batches/")) {
    const id = pathname.split("/")[3];
    return withStateReadOnly(async (state) => {
      const batch = state.batches.find((entry) => entry.id === id);
      if (!batch) return notFound(res, "Batch not found");
      const cards = state.cardItems.filter((item) => item.batchId === id);
      return sendJson(res, 200, {
        batch,
        cards,
        images: state.cardImages.filter((image) =>
          cards.some((card) => card.id === image.cardItemId),
        ),
      });
    });
  }

  if (
    req.method === "POST" &&
    pathname.startsWith("/api/batches/") &&
    pathname.endsWith("/cards")
  ) {
    const batchId = pathname.split("/")[3];
    const body = await readJson(req);
    const cards = Array.isArray(body.cards) ? body.cards : [];
    const result = await withState(async (state) => {
      const batch = state.batches.find((entry) => entry.id === batchId);
      if (!batch) return notFound(res, "Batch not found");
      const created = [];
      for (const entry of cards) {
        const cardItemId = createId(state, "card");
        const isThickCard =
          entry.thickCard === true || entry.thickCard === "true" || entry.isThickCard === true;
        const isBaseCard =
          entry.baseCardHint === true || entry.baseCardHint === "true" || entry.isBaseCard === true;
        const isAutoCard =
          entry.autoCardHint === true ||
          entry.autoCardHint === "true" ||
          entry.isAutoCard === true ||
          /\bauto\b|\bautograph\b|\bsigned\b|\bsignature\b/i.test(String(entry.notes || ""));
        const cardItem = {
          id: cardItemId,
          batchId,
          status: "new",
          confidenceScore: 0,
          recommendedPrice: null,
          currency: "USD",
          isThickCard,
          candidateBaseHint: isBaseCard,
          candidateAutoHint: isAutoCard,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          publishState: "draft",
        };
        state.cardItems.push(cardItem);
        const frontImage = await saveImageRecord(state, {
          cardItemId,
          side: "front",
          dataUrl: entry.front.dataUrl,
          fileName: entry.front.fileName,
        });
        const backImage = await saveImageRecord(state, {
          cardItemId,
          side: "back",
          dataUrl: entry.back.dataUrl,
          fileName: entry.back.fileName,
        });
        state.cardImages.push(frontImage, backImage);
        cardItem.frontImageId = frontImage.id;
        cardItem.backImageId = backImage.id;
        cardItem.notes = entry.notes || "";
        cardItem.sku = entry.sku || `${batchId}-${cardItemId}`;
        if (entry.parallel) {
          cardItem.candidateParallel = entry.parallel;
        }
        if (entry.printRun) {
          const parsedPrintRun = parsePrintRunInput(entry.printRun);
          cardItem.printRun = parsedPrintRun.printRun;
          cardItem.serialNumber = parsedPrintRun.serialNumber;
        }
        cardItem.status = "ocr_pending";
        created.push(cardItem);
      }
      batch.updatedAt = nowIso();
      batch.status = "processing";
      createAuditEvent(state, "batch", batchId, "cards_uploaded", { cardCount: created.length });
      return { batchId, createdIds: created.map((card) => card.id), created };
    });
    if (!result) return;
    for (const cardItemId of result.createdIds) {
      await processCardItem(cardItemId);
    }
    return sendJson(res, 201, { batchId, created: result.created });
  }

  if (req.method === "GET" && pathname === "/api/card-items") {
    return withStateReadOnly(async (state) => {
      return sendJson(res, 200, {
        cardItems: state.cardItems.map((card) =>
          cleanCard(card, state.offers.filter((offer) => offer.cardItemId === card.id))),
      });
    });
  }

  if (req.method === "GET" && pathname.startsWith("/api/card-items/")) {
    const id = pathname.split("/")[3];
    return withStateReadOnly(async (state) => {
      const card = state.cardItems.find((item) => item.id === id);
      if (!card) return notFound(res, "Card item not found");
      const images = state.cardImages.filter((image) => image.cardItemId === id);
      const comps = state.comps.filter((comp) => comp.cardItemId === id);
      const offerEntries = state.offers.filter((entry) => entry.cardItemId === id);
      const offer = offerEntries.find(Boolean) || null;
      return sendJson(res, 200, {
        card: cleanCard(card, offerEntries),
        images,
        comps,
        offer,
        externalSoldComps: card.externalSoldComps || [],
      });
    });
  }

  if (req.method === "GET" && pathname === "/api/export-state") {
    const data = await exportState();
    return sendJson(res, 200, data);
  }

  if (req.method === "POST" && pathname === "/api/import-state") {
    const body = await readJson(req);
    await importState(body);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/reconcile-listings") {
    const result = await withState(async (state) => {
      let fixedCount = 0;
      let movedCount = 0;
      const fixedCardIds = [];
      const movedCardIds = [];
      for (const card of state.cardItems) {
        const offers = state.offers.filter((offer) => offer.cardItemId === card.id);
        const publishedOffer = getPublishedOfferForCard(card, offers);
        const isPublishedCard = isCardPublished(card, offers);
        if (!isPublishedCard) continue;

        const nextStatus = "listed";
        const nextPublishState = "published";
        const nextListingUrl = card.listingUrl || publishedOffer?.listingUrl || card.listingUrl;
        const previousStatus = card.status;
        const previousPublishState = card.publishState;
        const previousListingUrl = card.listingUrl;
        const changed =
          card.status !== nextStatus || card.publishState !== nextPublishState || card.listingUrl !== nextListingUrl;

        card.status = nextStatus;
        card.publishState = nextPublishState;
        if (!card.listingUrl && publishedOffer?.listingUrl) {
          card.listingUrl = publishedOffer.listingUrl;
        }
        if (changed) {
          card.updatedAt = nowIso();
        }
        if (changed) {
          fixedCount += 1;
          fixedCardIds.push(card.id);
          createAuditEvent(
            state,
            "cardItem",
            card.id,
            "listing_reconciled",
            {
              offerId: publishedOffer?.id || null,
              offerStatus: publishedOffer?.status || null,
              previousStatus,
              previousPublishState,
              previousListingUrl,
            },
          );
        }

        if (isPublishedCard) {
          try {
            await moveListedCardDriveImages(card);
            movedCount += 1;
            movedCardIds.push(card.id);
          } catch {
            // continue
          }
        }
      }
      return { fixed: fixedCount, fixedCardIds, moved: movedCount, movedCardIds };
    });
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && (pathname === "/api/cleanup-listed-drive-cards" || pathname === "/api/cleanup-listed-drive-cards/")) {
    const body = await readJson(req).catch(() => ({}));
    const dryRun = body?.dryRun === true;
    const result = await withState(async (state) => {
      let eligibleCount = 0;
      let movedCount = 0;
      const movedCardIds = [];
      const skippedCardIds = [];
      for (const card of state.cardItems) {
        const offers = state.offers.filter((offer) => offer.cardItemId === card.id);
        if (!isCardPublished(card, offers)) continue;
        eligibleCount += 1;
        if (!card?.driveSourceFolderId && !card?.driveFrontFileId && !card?.driveBackFileId) {
          skippedCardIds.push(card.id);
          continue;
        }
        if (!dryRun) {
          await moveListedCardDriveImages(card);
          movedCount += 1;
        } else {
          movedCount += 1;
        }
        movedCardIds.push(card.id);
      }
      return {
        dryRun,
        eligibleCount,
        movedCount,
        movedCardIds,
        skippedCardIds,
      };
    });
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && pathname === "/api/enable-best-offers") {
    const result = await withState(async (state) => {
      const candidates = state.offers.filter(
        (offer) => offer.ebayOfferId && offer.status !== "deleted",
      );
      const toUpdate = [];
      for (const offer of candidates) {
        const existingBestOfferTerms = offer.requestPayload?.bestOfferTerms || {};
        if (existingBestOfferTerms.bestOfferEnabled === true) continue;
        offer.requestPayload = {
          ...(offer.requestPayload || {}),
          bestOfferTerms: {
            ...existingBestOfferTerms,
            bestOfferEnabled: true,
          },
        };
        toUpdate.push(offer);
      }
      if (toUpdate.length === 0) {
        return {
          totalCandidates: candidates.length,
          updatedCount: 0,
          alreadyEnabledCount: candidates.length,
          updatedOfferIds: [],
        };
      }
      const updated = await updateOfferPrices(toUpdate);
      const updatedOfferIds = [];
      for (const updatedOffer of updated) {
        const target = state.offers.find((entry) => entry.id === updatedOffer.id);
        if (!target) continue;
        target.status = updatedOffer.status;
        target.requestPayload = updatedOffer.requestPayload || target.requestPayload;
        target.syncedAt = updatedOffer.syncedAt || nowIso();
        target.updatedAt = nowIso();
        updatedOfferIds.push(target.id);
      }
      return {
        totalCandidates: candidates.length,
        updatedCount: updatedOfferIds.length,
        alreadyEnabledCount: candidates.length - toUpdate.length,
        updatedOfferIds,
      };
    });
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && pathname.match(/^\/api\/card-items\/[^/]+\/comp-toggle$/)) {
    const id = pathname.split("/")[3];
    const body = await readJson(req);
    return withState(async (state) => {
      const card = state.cardItems.find((item) => item.id === id);
      if (!card) return notFound(res, "Card item not found");
      const compId = body.compId;
      if (!compId) return sendJson(res, 400, { error: "compId required" });
      const excluded = card.excludedCompIds || [];
      const index = excluded.indexOf(compId);
      if (index >= 0) {
        excluded.splice(index, 1);
      } else {
        excluded.push(compId);
      }
      card.excludedCompIds = excluded;
      card.updatedAt = nowIso();
      createAuditEvent(state, "cardItem", id, "comp_toggled", { compId, excluded: index < 0 });
      return sendJson(res, 200, { excludedCompIds: excluded });
    });
  }

  if (req.method === "POST" && pathname.match(/^\/api\/batches\/[^/]+\/checklist$/)) {
    const id = pathname.split("/")[3];
    const body = await readJson(req);
    return withState(async (state) => {
      const batch = state.batches.find((entry) => entry.id === id);
      if (!batch) return notFound(res, "Batch not found");
      batch.publishChecklist = body.checklist || [];
      batch.updatedAt = nowIso();
      return sendJson(res, 200, { checklist: batch.publishChecklist });
    });
  }

  if (req.method === "PATCH" && pathname.startsWith("/api/card-items/")) {
    const id = pathname.split("/")[3];
    const body = await readJson(req);
    return withState(async (state) => {
      const card = state.cardItems.find((item) => item.id === id);
      if (!card) return notFound(res, "Card item not found");
      const patch = buildReviewPatch(body, card);
      const reviewOverrides = buildReviewOverrideMap(patch, card);
      Object.assign(card, patch, {
        reviewOverrides,
        updatedAt: nowIso(),
      });
      createAuditEvent(state, "cardItem", id, "updated", patch);
      return sendJson(res, 200, card);
    });
  }

  if (
    req.method === "POST" &&
    pathname.startsWith("/api/card-items/") &&
    pathname.endsWith("/review")
  ) {
    const id = pathname.split("/")[3];
    const body = await readJson(req);
    const needsIdentityRefresh = reviewPatchTouchesIdentity(body);
    const reviewPatch = await withState(async (state) => {
      const card = state.cardItems.find((item) => item.id === id);
      if (!card) return notFound(res, "Card item not found");
      const patch = buildReviewPatch(body, card);
      const reviewOverrides = buildReviewOverrideMap(patch, card);
      if (needsIdentityRefresh) {
        clearCardProcessingCaches(card);
        card.ebayTitle = "";
        card.ebayDescription = "";
        card.ebaySpecifics = null;
      }
      Object.assign(card, patch, {
        reviewOverrides,
        updatedAt: nowIso(),
        status: "ocr_pending",
      });
      createAuditEvent(state, "cardItem", id, "review_updated", patch);
      return patch;
    });
    if (!reviewPatch) return;
    await processCardItem(id);
    const reviewedCard = await withState(async (state) => {
      const card = state.cardItems.find((item) => item.id === id);
      if (!card) return null;
      if (needsIdentityRefresh) {
        card.ebayTitle = buildEBayTitleForCard(card);
        card.ebayDescription = await buildEBayDescriptionForCard(card, { force: true });
        card.ebaySpecifics = buildItemSpecificsForCard(card);
        card.updatedAt = nowIso();
      }
      return card;
    });
    return sendJson(res, 200, {
      card: reviewedCard,
      patch: reviewPatch,
    });
  }

  if (
    req.method === "POST" &&
    pathname.startsWith("/api/card-items/") &&
    pathname.endsWith("/process")
  ) {
    const id = pathname.split("/")[3];
    const card = await processCardItem(id);
    return sendJson(res, 200, card);
  }

  if (
    req.method === "POST" &&
    pathname.startsWith("/api/card-items/") &&
    pathname.endsWith("/approve")
  ) {
    const id = pathname.split("/")[3];
    return withState(async (state) => {
      const card = state.cardItems.find((item) => item.id === id);
      if (!card) return notFound(res, "Card item not found");
      card.status = "ready";
      card.updatedAt = nowIso();
      createAuditEvent(state, "cardItem", id, "approved", {});
      return sendJson(res, 200, card);
    });
  }

  if (
    req.method === "POST" &&
    pathname.startsWith("/api/card-items/") &&
    pathname.endsWith("/send-to-grading")
  ) {
    if (!isGradingFeatureEnabled()) {
      return sendJson(res, 404, { error: "The grading feature is currently disabled." });
    }
    const id = pathname.split("/")[3];
    return withState(async (state) => {
      const card = state.cardItems.find((item) => item.id === id);
      if (!card) return notFound(res, "Card item not found");
      // normalizeState() (src/lib/store.js) forces status/publishState back
      // to listed/published for any card with a real listingUrl on every
      // read, so this would otherwise silently no-op for an already-live
      // listing — reject explicitly instead of pretending it worked.
      const isPublished = card.status === "listed" || card.publishState === "published" || Boolean(card.listingUrl);
      if (isPublished) {
        return sendJson(res, 409, { error: "This card is already listed on eBay — send it to grading before listing it, not after." });
      }
      card.status = "sent_to_grading";
      card.sentToGradingAt = nowIso();
      card.updatedAt = nowIso();
      createAuditEvent(state, "cardItem", id, "sent_to_grading", {});
      return sendJson(res, 200, card);
    });
  }

  if (
    req.method === "POST" &&
    pathname.startsWith("/api/card-items/") &&
    pathname.endsWith("/return-from-grading")
  ) {
    const id = pathname.split("/")[3];
    return withState(async (state) => {
      const card = state.cardItems.find((item) => item.id === id);
      if (!card) return notFound(res, "Card item not found");
      // Back to needs_review rather than straight to ready — a graded card
      // prices very differently than the raw card that went in, so the
      // pricing/comp evidence should get a fresh look before it's listed.
      // The reviewer edits candidateGrade/gradingCompany/certificationNumber
      // through the existing review panel (already supports these fields —
      // see the review-patch handler above and src/services/ebay-condition.js,
      // which already builds eBay's graded-card condition descriptors from
      // exactly these fields) and hits "Save & reprocess" as normal.
      card.status = "needs_review";
      card.returnedFromGradingAt = nowIso();
      card.updatedAt = nowIso();
      createAuditEvent(state, "cardItem", id, "returned_from_grading", {});
      return sendJson(res, 200, card);
    });
  }

  if (req.method === "DELETE" && pathname.startsWith("/api/card-items/")) {
    const id = pathname.split("/")[3];
    return withState(async (state) => {
      const idx = state.cardItems.findIndex((item) => item.id === id);
      if (idx === -1) return notFound(res, "Card item not found");
      state.cardItems.splice(idx, 1);
      state.cardImages = state.cardImages.filter((img) => img.cardItemId !== id);
      state.comps = state.comps.filter((comp) => comp.cardItemId !== id);
      state.offers = state.offers.filter((offer) => offer.cardItemId !== id);
      state.auditEvents = state.auditEvents.filter(
        (ev) => ev.cardItemId !== id && (ev.targetId !== id || ev.targetType !== "cardItem"),
      );
      createAuditEvent(state, "cardItem", id, "deleted", {});
      return sendJson(res, 200, { ok: true });
    });
  }

  if (
    req.method === "POST" &&
    pathname.startsWith("/api/card-items/") &&
    pathname.endsWith("/import-apify-comps")
  ) {
    const id = pathname.split("/")[3];
    const body = await readJson(req);
    const incomingRows =
      body?.rows ?? body?.listings ?? body?.results ?? body?.items ?? body?.records ?? null;
    const sourceRows = Array.isArray(incomingRows) ? incomingRows : body;
    if (!Array.isArray(incomingRows)) {
      return sendJson(res, 400, { error: "No card rows provided to import." });
    }
    const result = await withState(async (state) => {
      const card = state.cardItems.find((item) => item.id === id);
      if (!card) return notFound(res, "Card item not found");

      const meta = {
        playerName: card?.candidatePlayer || "",
        sport: card?.candidateSport || "",
        year: card?.candidateYear || null,
        setName: card?.candidateSetName || "",
        cardNumber: card?.candidateCardNumber || "",
        parallel: card?.candidateParallel || "",
        grade: card?.candidateGrade || "",
        gradedFlag: card?.candidateCondition === "graded",
        compGradeOverride: card?.compGradeOverride || null,
        compMatchMode: card?.compMatchMode || "auto",
        rookieFlag: Boolean(card?.candidateRookieFlag),
        variantLabel: card?.candidateVariantLabel || "",
        serialNumber: card?.serialNumber || null,
        printRun: card?.printRun || null,
        titleHint: card?.ebayTitle || "",
      };

      const importedResult = parseApifySoldListings(sourceRows, meta);

      const isTradingCardComp =
        /\b(trading cards|pokemon|magic|mtg|yugioh|yu gi oh|lorcana|one piece|digimon|star wars|marvel|dc|non sport|non-sport)\b/i.test(
          String(meta?.sport || meta?.setName || meta?.titleHint || ""),
        );
      const requestedLimit = Math.max(
        Number(process.env.SOLDCOMPS_COUNT || process.env.APIFY_EBAY_SOLD_COUNT || 10),
        isTradingCardComp ? 15 : 10,
      );
      const importLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(Math.round(requestedLimit), 100)
        : isTradingCardComp
          ? 15
          : 10;
      const imported = importedResult.comps.slice(0, importLimit);
      card.externalSoldComps = imported;
      card.externalCompSource = "soldcomps";
      card.externalCompMatch = null;
      card.externalCompMatchWarning = null;
      card.externalPricingSummary = null;
      card.externalCompUpdatedAt = nowIso();
      card.apifyLookupKey = buildApifyLookupKey(meta);
      card.apifySearchKeywords = Array.isArray(importedResult.keywordsUsed)
        ? importedResult.keywordsUsed
        : [];
      card.apifySearchQuery = card.apifySearchKeywords.length
        ? card.apifySearchKeywords.join(" · ")
        : null;
      delete card.apifyError;
      const existingActiveListings = state.comps
        .filter((comp) => comp.cardItemId === id && comp.source === "browse_active");
      const frontImage = state.cardImages.find((image) => image.id === card.frontImageId);
      const backImage = state.cardImages.find((image) => image.id === card.backImageId);
      const liveComps = await getLiveCardComps(
        meta,
        frontImage?.storagePath || null,
        backImage?.storagePath || null,
        null,
        imported,
      );
      const refreshedActiveListings = Array.isArray(liveComps.active) ? liveComps.active : [];
      const activeListings = refreshedActiveListings.length
        ? refreshedActiveListings
        : existingActiveListings;
      if (refreshedActiveListings.length) {
        state.comps = state.comps.filter(
          (comp) => comp.cardItemId !== id || comp.source !== "browse_active",
        );
      }
      for (const comp of refreshedActiveListings) {
        state.comps.push({
          id: createId(state, "comp"),
          cardItemId: id,
          source: "browse_active",
          listingId: comp.id || comp.listingId || null,
          title: comp.title || null,
          conditionLabel: comp.conditionLabel || null,
          salePrice: comp.salePrice ?? null,
          shippingPrice: comp.shippingPrice ?? null,
          totalPrice: comp.totalPrice ?? comp.price ?? null,
          soldAt: comp.soldAt ?? null,
          url: comp.url ?? null,
          matchScore: comp.matchScore ?? null,
          rawPayload: comp,
          createdAt: nowIso(),
        });
      }
      const pricing = calculatePrice({
        soldComps: imported,
        activeListings,
        strategy: card.pricingStrategy || "sold_comps_p25",
        metadata: {
          parallel: card?.candidateParallel || "",
          baseHint: Boolean(card?.candidateBaseHint),
          variantLabel: card?.candidateVariantLabel || "",
          rookieFlag: Boolean(card?.candidateRookieFlag),
          serialNumber: card?.serialNumber || null,
          printRun: card?.printRun || null,
        },
      });
      card.recommendedPrice = pricing.recommendedPrice;
      card.pricingConfidence = pricing.confidence;
      card.pricingReason = pricing.reason;
      card.pricingEvidence = pricing.evidence;
      card.marketDataSource = activeListings.length ? "ebay_browse" : "local";
      card.updatedAt = nowIso();
      createAuditEvent(state, "cardItem", id, "apify_comps_imported", {
        importedCount: imported.length,
        rejectedCount: importedResult.rejectedCount || 0,
        sampleTitles: importedResult.sampleTitles || [],
      });
      return {
        card,
        importedCount: imported.length,
        rejectedCount: importedResult.rejectedCount || 0,
        sampleTitles: importedResult.sampleTitles || [],
      };
    });
    if (!result) return;
    return sendJson(res, 200, result);
  }

  if (
    req.method === "POST" &&
    pathname.startsWith("/api/batches/") &&
    pathname.endsWith("/process")
  ) {
    const batchId = pathname.split("/")[3];
    const batch = await processBatch(batchId);
    return sendJson(res, 200, batch);
  }

  if (
    req.method === "POST" &&
    pathname.startsWith("/api/card-items/") &&
    (pathname.endsWith("/offer") || pathname.endsWith("/offer/auction"))
  ) {
    const id = pathname.split("/")[3];
    const body = await readJson(req).catch(() => ({}));
    const listingConfig = parseEbayListingConfigFromBody(body || {});
    if (pathname.endsWith("/offer/auction")) {
      listingConfig.ebayListingFormat = "AUCTION";
    }
    return withState(async (state) => {
      const card = state.cardItems.find((item) => item.id === id);
      if (!card) return notFound(res, "Card item not found");
      if (Object.keys(listingConfig).length > 0) {
        Object.assign(card, listingConfig);
      }
      const existingOffer = state.offers.find((entry) => entry.cardItemId === id);
      let offerData;
      const frontImage = state.cardImages.find((img) => img.cardItemId === id && img.side === "front");
      const backImage = state.cardImages.find((img) => img.cardItemId === id && img.side === "back");
      const cardWithUrl = {
        ...card,
        ...listingConfig,
        frontImageUrl: resolveEbayImageUrl(frontImage?.url, req) || card.frontImageUrl,
        backImageUrl: resolveEbayImageUrl(backImage?.url, req) || card.backImageUrl,
      };
      const canUpdateOffer =
        Boolean(existingOffer?.ebayOfferId) &&
        existingOffer.status !== "failed" &&
        existingOffer.status !== "deleted";
      if (canUpdateOffer) {
        const price = card.recommendedPrice ?? 0;
        const updated = await updateOfferPrices([{ ...existingOffer, ...cardWithUrl, recommendedPrice: price }]);
        offerData = updated[0];
      } else {
        const drafts = await createDraftOffers([cardWithUrl]);
        const ensuredDrafts = await ensureBestOfferTermsInOffers(drafts);
        offerData = ensuredDrafts[0];
      }
      let offer;
      if (existingOffer) {
        Object.assign(existingOffer, {
          ebayOfferId: offerData.ebayOfferId || existingOffer.ebayOfferId,
          sku: offerData.sku || existingOffer.sku,
          price: card.recommendedPrice,
          status: offerData.status,
          listingId: offerData.listingId || existingOffer.listingId || extractEbayListingId(offerData.listingUrl || existingOffer.listingUrl),
          listingUrl: offerData.listingUrl || existingOffer.listingUrl,
          publishedAt: offerData.publishedAt || existingOffer.publishedAt,
          requestPayload: offerData.requestPayload || existingOffer.requestPayload || null,
          updatedAt: nowIso(),
        });
        offer = existingOffer;
      } else {
        offer = {
          id: createId(state, "off"),
          cardItemId: card.id,
          ebayOfferId: offerData.ebayOfferId,
          inventoryItemId: offerData.inventoryItemId,
          sku: offerData.sku,
          price: card.recommendedPrice,
          quantity: 1,
          isThickCard: Boolean(card.isThickCard),
          status: offerData.status,
          listingId: offerData.listingId || extractEbayListingId(offerData.listingUrl),
          listingUrl: offerData.listingUrl || null,
          publishedAt: offerData.publishedAt,
          requestPayload: offerData.requestPayload || null,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        state.offers.push(offer);
      }
      card.status = offerData.status === "published" ? "listed" : "priced";
      card.publishState = offerData.status === "published" ? "published" : "draft";
      card.updatedAt = nowIso();
      createAuditEvent(state, "cardItem", id, "offer_created", { status: offer.status });
      return sendJson(res, 200, { offer, card });
    });
  }

  if (
    req.method === "POST" &&
    pathname.match(/^\/api\/offers\/[^/]+\/publish$/)
  ) {
    const id = pathname.split("/")[3];
    return withState(async (state) => {
      const offer = state.offers.find((entry) => entry.id === id);
      if (!offer) return notFound(res, "Offer not found");
      if (!offer.ebayOfferId) return sendJson(res, 400, { error: "Offer has no eBay offer ID" });
      // Re-PUT the inventory item before publishing, same as the
      // batch-create-offers route already does for existing offers (see
      // canUpdateByOfferStatus above). Without this, publishing an offer
      // whose inventory item was created before a later code/data fix (e.g.
      // a corrected condition value, an edited title, updated specifics)
      // just republishes the stale data that's still sitting on eBay's
      // side — confirmed directly: this offer kept failing with the exact
      // same condition-validation error after the mapCondition fix shipped,
      // because publish alone never re-sends the inventory item.
      const card = state.cardItems.find((entry) => entry.id === offer.cardItemId);
      if (card) {
        // card.frontImageUrl/backImageUrl are never actually populated as
        // direct fields on the card record — the real URLs live on the
        // separate cardImages entries. The batch-create-offers route's
        // resolveUrl() already does this same lookup + relative-to-absolute
        // resolution (resolveEbayImageUrl) before calling
        // createInventoryItem there; without it here too, the PUT went out
        // with an empty imageUrls array and eBay rejected it.
        const frontImage = state.cardImages.find((i) => i.cardItemId === card.id && i.side === "front");
        const backImage = state.cardImages.find((i) => i.cardItemId === card.id && i.side === "back");
        await createInventoryItem({
          ...card,
          frontImageUrl: resolveEbayImageUrl(frontImage?.url, req) || card.frontImageUrl,
          backImageUrl: resolveEbayImageUrl(backImage?.url, req) || card.backImageUrl,
        });
      }
      if (normalizeOfferBestOfferTerms(offer)) {
        const updated = await updateOfferPrices([offer]);
        Object.assign(offer, updated?.[0] || {});
      }
      const published = await publishOffers([offer]);
      const item = published[0];
      offer.status = item.status;
      offer.listingId = item.listingId || offer.listingId || extractEbayListingId(item.listingUrl);
      offer.listingUrl = item.listingUrl;
      offer.publishedAt = item.publishedAt;
      offer.requestPayload = item.requestPayload || offer.requestPayload || null;
      offer.updatedAt = nowIso();
      if (card) {
        card.status = "listed";
        card.publishState = "published";
        card.listingId = offer.listingId || extractEbayListingId(offer.listingUrl);
        card.listingUrl = offer.listingUrl;
        card.updatedAt = nowIso();
        // movePublishedDriveImages() can derive the source folder itself
        // from driveFrontFileId/driveBackFileId's Drive metadata when
        // driveSourceFolderId wasn't set — requiring driveSourceFolderId
        // here too defeated that fallback and would silently skip the move
        // for any card missing just that one field.
        if (card.driveSourceFolderId || card.driveFrontFileId || card.driveBackFileId) {
          movePublishedDriveImages(card).catch(() => {});
        }
      }
      createAuditEvent(state, "offer", id, "published", { listingUrl: offer.listingUrl });
      return sendJson(res, 200, { offer, card });
    });
  }

  if (
    req.method === "POST" &&
    pathname.startsWith("/api/batches/") &&
    pathname.endsWith("/offers/create")
  ) {
    const batchId = pathname.split("/")[3];
    return withState(async (state) => {
      const cards = state.cardItems.filter((item) => item.batchId === batchId);
      const existingOffers = state.offers.filter((o) => cards.some((c) => c.id === o.cardItemId));
      const existingOfferMap = {};
      for (const o of existingOffers) existingOfferMap[o.cardItemId] = o;

      const cardImages = state.cardImages;
      const resolveUrl = (c) => {
        const front = cardImages.find((i) => i.cardItemId === c.id && i.side === "front");
        const back = cardImages.find((i) => i.cardItemId === c.id && i.side === "back");
        return {
          ...c,
          frontImageUrl: resolveEbayImageUrl(front?.url, req) || c.frontImageUrl,
          backImageUrl: resolveEbayImageUrl(back?.url, req) || c.backImageUrl,
        };
      };
      const canUpdateByOfferStatus = (card) => {
        const offer = existingOfferMap[card.id];
        return Boolean(offer?.ebayOfferId) && offer.status !== "failed" && offer.status !== "deleted";
      };
      const newCards = cards.filter((c) => !canUpdateByOfferStatus(c)).map(resolveUrl);
      const updateCards = cards.filter(canUpdateByOfferStatus);

      const results = [];

      if (newCards.length) {
        const draftOffers = await createDraftOffers(newCards);
        const ensuredDrafts = await ensureBestOfferTermsInOffers(draftOffers);
        const published = await publishOffers(ensuredDrafts);
        results.push(...published);
      }

      if (updateCards.length) {
        const resolvedUpdateCards = updateCards.map(resolveUrl);
        for (const card of resolvedUpdateCards) {
          await createInventoryItem(card);
        }
        const updated = await updateOfferPrices(
          resolvedUpdateCards.map((c) => {
            const existing = existingOfferMap[c.id];
            return { ...existing, ...c, recommendedPrice: c.recommendedPrice ?? 0 };
          }),
        );
        const ensuredUpdated = await ensureBestOfferTermsInOffers(updated);
        results.push(...ensuredUpdated);
      }

      const created = [];
      for (let index = 0; index < cards.length; index += 1) {
        const card = cards[index];
        const offerData = results.find((r) => r.sku === (card.sku || `${batchId}-${card.id}`));
        const existingOffer = existingOfferMap[card.id];
        let offer;
        const offerStatus = offerData?.status || existingOffer?.status || null;
        const isListed = ["published", "active", "listed"].includes(offerStatus);
        if (existingOffer) {
          Object.assign(existingOffer, {
            ebayOfferId: offerData?.ebayOfferId || existingOffer.ebayOfferId,
            sku: offerData?.sku || existingOffer.sku,
            price: card.recommendedPrice,
            status: offerData?.status || existingOffer.status,
            listingId: offerData?.listingId || existingOffer.listingId || extractEbayListingId(offerData?.listingUrl || existingOffer.listingUrl),
            listingUrl: offerData?.listingUrl || existingOffer.listingUrl,
            publishedAt: offerData?.publishedAt || existingOffer.publishedAt,
            requestPayload: offerData?.requestPayload || existingOffer.requestPayload || null,
            updatedAt: nowIso(),
          });
          offer = existingOffer;
        } else {
          offer = {
            id: createId(state, "off"),
            cardItemId: card.id,
            ebayOfferId: offerData?.ebayOfferId,
            inventoryItemId: offerData?.inventoryItemId,
            sku: offerData?.sku || card.sku,
            price: card.recommendedPrice,
            quantity: 1,
            isThickCard: Boolean(card.isThickCard),
            status: offerData?.status || "created",
            listingId: offerData?.listingId || extractEbayListingId(offerData?.listingUrl),
            listingUrl: offerData?.listingUrl || null,
            requestPayload: offerData?.requestPayload || null,
            publishedAt: offerData?.publishedAt,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };
          state.offers.push(offer);
        }
        created.push(offer);
        card.status = isListed ? "listed" : "priced";
        card.publishState = isListed ? "published" : "draft";
        card.listingUrl = offerData?.listingUrl || card.listingUrl || null;
        if (isListed) {
          moveListedCardDriveImages(card).catch(() => {});
        }
        card.updatedAt = nowIso();
      }
      createAuditEvent(state, "batch", batchId, "offers_created", { offerCount: created.length });
      return sendJson(res, 200, { batchId, offers: created });
    });
  }

  if (
    req.method === "POST" &&
    pathname.startsWith("/api/batches/") &&
    pathname.endsWith("/offers/update-prices")
  ) {
    const batchId = pathname.split("/")[3];
    return withState(async (state) => {
      const offers = state.offers.filter((offer) =>
        state.cardItems.some((card) => card.id === offer.cardItemId && card.batchId === batchId),
      );
      const updated = await updateOfferPrices(offers);
      const ensuredOffers = await ensureBestOfferTermsInOffers(updated);
      for (const item of ensuredOffers) {
        const offer = state.offers.find((entry) => entry.id === item.id);
        if (offer) {
          offer.status = item.status;
          offer.updatedAt = nowIso();
          offer.syncedAt = item.syncedAt;
          offer.requestPayload = item.requestPayload || offer.requestPayload || null;
        }
      }
      createAuditEvent(state, "batch", batchId, "offers_updated", { offerCount: ensuredOffers.length });
      return sendJson(res, 200, { batchId, offers: ensuredOffers });
    });
  }

  if (
    req.method === "POST" &&
    pathname.startsWith("/api/batches/") &&
    pathname.endsWith("/publish")
  ) {
    const batchId = pathname.split("/")[3];
    return withState(async (state) => {
      const offers = state.offers.filter((offer) =>
        state.cardItems.some((card) => card.id === offer.cardItemId && card.batchId === batchId),
      );
      const needsBestOfferUpdate = [];
      for (const offer of offers) {
        if (normalizeOfferBestOfferTerms(offer)) needsBestOfferUpdate.push(offer);
      }
      if (needsBestOfferUpdate.length > 0) {
        await updateOfferPrices(needsBestOfferUpdate);
      }
      const published = await publishOffers(offers);
      for (const item of published) {
        const offer = state.offers.find((entry) => entry.id === item.id);
        if (offer) {
          offer.status = item.status;
          offer.listingId = item.listingId || offer.listingId || extractEbayListingId(item.listingUrl);
          offer.listingUrl = item.listingUrl;
          offer.updatedAt = nowIso();
          offer.publishedAt = item.publishedAt;
          offer.requestPayload = item.requestPayload || offer.requestPayload || null;
        }
        const card = state.cardItems.find((entry) => entry.id === item.cardItemId);
        if (card) {
          card.status = "listed";
          card.publishState = "published";
          card.listingId = item.listingId || extractEbayListingId(item.listingUrl);
          card.listingUrl = item.listingUrl;
          card.updatedAt = nowIso();
          // See the equivalent single-offer-publish route above for why
          // driveSourceFolderId isn't required here on its own.
          if (card.driveSourceFolderId || card.driveFrontFileId || card.driveBackFileId) {
            movePublishedDriveImages(card).catch(() => {});
          }
        }
      }
      const batch = state.batches.find((entry) => entry.id === batchId);
      if (batch) {
        batch.status = "published";
        batch.updatedAt = nowIso();
      }
      createAuditEvent(state, "batch", batchId, "published", { offerCount: published.length });
      return sendJson(res, 200, { batchId, offers: published });
    });
  }

  if (req.method === "DELETE" && pathname.startsWith("/api/offers/")) {
    const id = pathname.split("/")[3];
    return withState(async (state) => {
      const offer = state.offers.find((entry) => entry.id === id);
      if (!offer) return notFound(res, "Offer not found");
      if (offer.ebayOfferId) {
        try {
          await deleteEbayOffer(offer.ebayOfferId);
        } catch {
          // proceed with local cleanup even if eBay delete fails
        }
      }
      const idx = state.offers.indexOf(offer);
      state.offers.splice(idx, 1);
      const card = state.cardItems.find((entry) => entry.id === offer.cardItemId);
      if (card) {
        card.status = "ready";
        card.publishState = "draft";
        card.updatedAt = nowIso();
      }
      createAuditEvent(state, "offer", id, "deleted", { ebayOfferId: offer.ebayOfferId });
      return sendJson(res, 200, { deleted: true });
    });
  }

  if (req.method === "GET" && pathname === "/api/debug/condition-policies") {
    try {
      const config = getEbayConfig();
      const resp = await fetch(`https://api.ebay.com/sell/metadata/v1/marketplace/EBAY_US/get_item_condition_policies?category_id=261328`, {
        headers: {
          Authorization: `Bearer ${config.userAccessToken}`,
          "Content-Type": "application/json",
        },
      });
      const data = await resp.json();
      return sendJson(res, resp.status, data);
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (req.method === "GET" && pathname.startsWith("/files/")) {
    const name = pathname.slice("/files/".length);
    const filePath = path.join(imagesDir, name);
    if (!filePath.startsWith(imagesDir)) return notFound(res);
    try {
      const body = await fs.readFile(filePath);
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(body);
      return;
    } catch {
      const base = process.env.SUPABASE_URL;
      if (base) {
        const storageUrl = `${base}/storage/v1/object/public/card-images/${name}`;
        try {
          const check = await fetch(storageUrl, { method: "HEAD" });
          if (check.ok) {
            res.writeHead(302, { Location: storageUrl });
            res.end();
            return;
          }
        } catch {
          // fall through to 404
        }
      }
      return notFound(res, "Image not found");
    }
  }

  return notFound(res);
}
