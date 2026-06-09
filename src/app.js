import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, sendJson, notFound } from "./lib/http.js";
import { createAuditEvent, createId, nowIso, withState } from "./lib/store.js";
import { saveImageRecord } from "./lib/storage.js";
import { processBatch, processCardItem } from "./jobs/pipeline.js";
import { createDraftOffers, publishOffers, updateOfferPrices, getEbayConfig } from "./services/ebay.js";
import { fetchEbaySetup } from "./services/ebay-setup.js";
import { hasBrowseConfig } from "./services/ebay-browse.js";
import { parseApifySoldListings } from "./services/apify.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(rootDir, "public");
const imagesDir = path.join(rootDir, "data", "images");

async function serveStatic(req, res, pathname) {
  const filePath = pathname === "/" ? path.join(publicDir, "index.html") : path.join(publicDir, pathname.slice(1));
  if (!filePath.startsWith(publicDir)) {
    return notFound(res);
  }
  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const contentType = ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".css"
        ? "text/css; charset=utf-8"
        : ext === ".js"
          ? "text/javascript; charset=utf-8"
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

function cleanCard(card) {
  return { ...card };
}

function parsePrintRunInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return { printRun: null, serialNumber: null };

  const exactSerialMatch = /^(\d{1,3})\s*\/\s*(\d{1,4})$/.exec(raw);
  if (exactSerialMatch) {
    return {
      printRun: Number(exactSerialMatch[2]),
      serialNumber: `${exactSerialMatch[1]}/${exactSerialMatch[2]}`
    };
  }

  const printRunValue = Number(raw.replace(/^\//, ""));
  if (!Number.isFinite(printRunValue)) {
    return { printRun: null, serialNumber: null };
  }

  return {
    printRun: printRunValue,
    serialNumber: null
  };
}

function parseBoolean(value) {
  return value === true || value === "true" || value === "1" || value === 1 || value === "on";
}

function normalizeText(value) {
  const raw = String(value || "").trim();
  return raw ? raw : null;
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
    const variantLabel = normalizeText(body.candidateVariantLabel || body.variantLabel || existingCard.candidateVariantLabel || existingCard.variantLabel);
    return /rated rookie/i.test(variantLabel || "") ? "rated" : "generic";
  }
  return "none";
}

function normalizeAutographFlag(body = {}, existingCard = {}) {
  if (parseBoolean(body.autographHint ?? body.candidateAutoHint ?? existingCard.candidateAutoHint)) {
    return true;
  }
  const notes = String(body.notes ?? body.candidateNotes ?? existingCard.notes ?? "");
  return /\bauto\b|\bautograph\b|\bsigned\b|\bsignature\b/i.test(notes);
}

function buildReviewPatch(body = {}, existingCard = {}) {
  const rookieMode = normalizeRookieMode(body, existingCard);
  const parsedPrintRun = parsePrintRunInput(body.printRun ?? body.printRunValue ?? body.printRunHint ?? "");
  const explicitSerial = normalizeText(body.serialNumber ?? body.candidateSerialNumber ?? existingCard.serialNumber);
  return {
    candidatePlayer: normalizeText(body.playerName ?? body.candidatePlayer ?? existingCard.candidatePlayer),
    candidateYear: normalizeYear(body.year ?? body.candidateYear ?? existingCard.candidateYear),
    candidateSetName: normalizeText(body.setName ?? body.candidateSetName ?? existingCard.candidateSetName),
    candidateCardNumber: normalizeText(body.cardNumber ?? body.candidateCardNumber ?? existingCard.candidateCardNumber),
    candidateParallel: normalizeText(body.parallel ?? body.candidateParallel ?? existingCard.candidateParallel),
    candidateBaseHint: parseBoolean(body.baseHint ?? body.candidateBaseHint ?? existingCard.candidateBaseHint),
    candidateAutoHint: normalizeAutographFlag(body, existingCard),
    candidateRookieFlag: rookieMode !== "none",
    candidateVariantLabel: rookieMode === "rated"
      ? "Rated Rookie"
      : rookieMode === "generic"
        ? "Rookie RC"
        : null,
    candidateGrade: normalizeText(body.grade ?? body.candidateGrade ?? existingCard.candidateGrade),
    candidateCondition: parseBoolean(body.gradedFlag ?? body.isGraded)
      ? "graded"
      : normalizeText(body.candidateCondition ?? existingCard.candidateCondition) || existingCard.candidateCondition || "raw",
    isThickCard: parseBoolean(body.thickCard ?? body.isThickCard ?? existingCard.isThickCard),
    notes: normalizeText(body.notes ?? body.candidateNotes ?? existingCard.notes) || "",
    serialNumber: explicitSerial && !parsedPrintRun.serialNumber ? explicitSerial : parsedPrintRun.serialNumber || explicitSerial || null,
    printRun: parsedPrintRun.printRun ?? existingCard.printRun ?? null
  };
}

export async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (req.method === "GET" && (pathname === "/" || pathname.startsWith("/public/"))) {
    const served = await serveStatic(req, res, pathname === "/" ? "/" : pathname.replace("/public", ""));
    if (served) return;
  }

  if (req.method === "GET" && pathname === "/health") {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "automatic-sports-card-listing",
      ebay: getEbayConfig(),
      browse: {
        hasBrowseConfig: hasBrowseConfig()
      },
      apify: {
        hasApifyConfig: Boolean(process.env.APIFY_TOKEN),
        actorId: process.env.APIFY_EBAY_SOLD_ACTOR_ID || "caffein.dev~ebay-sold-listings"
      },
      openai: {
        hasVisionConfig: Boolean(process.env.OPENAI_API_KEY),
        model: process.env.OPENAI_VISION_MODEL || "gpt-4.1"
      }
    });
  }

  if (req.method === "GET" && pathname === "/api/ebay/setup") {
    try {
      const setup = await fetchEbaySetup();
      return sendJson(res, 200, setup);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "GET" && pathname === "/api/bootstrap") {
    return withState(async (state) => {
      return sendJson(res, 200, {
        batches: state.batches.map(cleanBatch),
        cardItems: state.cardItems.map(cleanCard)
      });
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
        updatedAt: nowIso()
      };
      state.batches.push(batch);
      createAuditEvent(state, "batch", batch.id, "created", body);
      return sendJson(res, 201, batch);
    });
  }

  if (req.method === "GET" && pathname.startsWith("/api/batches/")) {
    const id = pathname.split("/")[3];
    return withState(async (state) => {
      const batch = state.batches.find((entry) => entry.id === id);
      if (!batch) return notFound(res, "Batch not found");
      const cards = state.cardItems.filter((item) => item.batchId === id);
      return sendJson(res, 200, {
        batch,
        cards,
        images: state.cardImages.filter((image) => cards.some((card) => card.id === image.cardItemId))
      });
    });
  }

  if (req.method === "POST" && pathname.startsWith("/api/batches/") && pathname.endsWith("/cards")) {
    const batchId = pathname.split("/")[3];
    const body = await readJson(req);
    const cards = Array.isArray(body.cards) ? body.cards : [];
    const result = await withState(async (state) => {
      const batch = state.batches.find((entry) => entry.id === batchId);
      if (!batch) return notFound(res, "Batch not found");
      const created = [];
      for (const entry of cards) {
        const cardItemId = createId(state, "card");
        const isThickCard = entry.thickCard === true || entry.thickCard === "true" || entry.isThickCard === true;
        const isBaseCard = entry.baseCardHint === true || entry.baseCardHint === "true" || entry.isBaseCard === true;
        const isAutoCard = entry.autoCardHint === true || entry.autoCardHint === "true" || entry.isAutoCard === true || /\bauto\b|\bautograph\b|\bsigned\b|\bsignature\b/i.test(String(entry.notes || ""));
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
          publishState: "draft"
        };
        state.cardItems.push(cardItem);
        const frontImage = await saveImageRecord(state, {
          cardItemId,
          side: "front",
          dataUrl: entry.front.dataUrl,
          fileName: entry.front.fileName
        });
        const backImage = await saveImageRecord(state, {
          cardItemId,
          side: "back",
          dataUrl: entry.back.dataUrl,
          fileName: entry.back.fileName
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
    return withState(async (state) => {
      return sendJson(res, 200, { cardItems: state.cardItems });
    });
  }

  if (req.method === "GET" && pathname.startsWith("/api/card-items/")) {
    const id = pathname.split("/")[3];
    return withState(async (state) => {
      const card = state.cardItems.find((item) => item.id === id);
      if (!card) return notFound(res, "Card item not found");
      const images = state.cardImages.filter((image) => image.cardItemId === id);
      const comps = state.comps.filter((comp) => comp.cardItemId === id);
      const offer = state.offers.find((entry) => entry.cardItemId === id) || null;
      return sendJson(res, 200, { card, images, comps, offer, externalSoldComps: card.externalSoldComps || [] });
    });
  }

  if (req.method === "PATCH" && pathname.startsWith("/api/card-items/")) {
    const id = pathname.split("/")[3];
    const body = await readJson(req);
    return withState(async (state) => {
      const card = state.cardItems.find((item) => item.id === id);
      if (!card) return notFound(res, "Card item not found");
      Object.assign(card, body, { updatedAt: nowIso() });
      createAuditEvent(state, "cardItem", id, "updated", body);
      return sendJson(res, 200, card);
    });
  }

  if (req.method === "POST" && pathname.startsWith("/api/card-items/") && pathname.endsWith("/review")) {
    const id = pathname.split("/")[3];
    const body = await readJson(req);
    const reviewPatch = await withState(async (state) => {
      const card = state.cardItems.find((item) => item.id === id);
      if (!card) return notFound(res, "Card item not found");
      const patch = buildReviewPatch(body, card);
      Object.assign(card, patch, {
        updatedAt: nowIso(),
        status: "ocr_pending"
      });
      createAuditEvent(state, "cardItem", id, "review_updated", patch);
      return patch;
    });
    if (!reviewPatch) return;
    const reviewedCard = await processCardItem(id);
    return sendJson(res, 200, {
      card: reviewedCard,
      patch: reviewPatch
    });
  }

  if (req.method === "POST" && pathname.startsWith("/api/card-items/") && pathname.endsWith("/process")) {
    const id = pathname.split("/")[3];
    const card = await processCardItem(id);
    return sendJson(res, 200, card);
  }

  if (req.method === "POST" && pathname.startsWith("/api/card-items/") && pathname.endsWith("/approve")) {
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

  if (req.method === "POST" && pathname.startsWith("/api/card-items/") && pathname.endsWith("/import-apify-comps")) {
    const id = pathname.split("/")[3];
    const body = await readJson(req);
    const result = await withState(async (state) => {
      const card = state.cardItems.find((item) => item.id === id);
      if (!card) return notFound(res, "Card item not found");
      const parsed = parseApifySoldListings(body.rows ?? body.listings ?? body.results ?? body.items ?? body.records ?? body, {
        playerName: card.candidatePlayer || "",
        year: card.candidateYear || null,
        setName: card.candidateSetName || "",
        cardNumber: card.candidateCardNumber || "",
        parallel: card.candidateParallel || "",
        rookieFlag: Boolean(card.candidateRookieFlag),
        variantLabel: card.candidateVariantLabel || "",
        serialNumber: card.serialNumber || null,
        printRun: card.printRun || null
      });
      const imported = parsed.comps.slice(0, 10);
      card.externalSoldComps = imported;
      card.externalCompSource = "apify";
      card.externalCompUpdatedAt = nowIso();
      card.apifySearchKeywords = [];
      card.apifySearchQuery = null;
      delete card.apifyError;
      card.updatedAt = nowIso();
      createAuditEvent(state, "cardItem", id, "apify_comps_imported", {
        importedCount: imported.length,
        rejectedCount: parsed.rejectedCount,
        sampleTitles: parsed.sampleTitles
      });
      return {
        card,
        importedCount: imported.length,
        rejectedCount: parsed.rejectedCount,
        sampleTitles: parsed.sampleTitles
      };
    });
    if (!result) return;
    await processCardItem(id);
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && pathname.startsWith("/api/batches/") && pathname.endsWith("/process")) {
    const batchId = pathname.split("/")[3];
    const batch = await processBatch(batchId);
    return sendJson(res, 200, batch);
  }

  if (req.method === "POST" && pathname.startsWith("/api/batches/") && pathname.endsWith("/offers/create")) {
    const batchId = pathname.split("/")[3];
    return withState(async (state) => {
      const cards = state.cardItems.filter((item) => item.batchId === batchId && item.status !== "failed");
      const offers = await createDraftOffers(cards);
      const created = [];
      for (let index = 0; index < cards.length; index += 1) {
        const card = cards[index];
        const offerData = offers[index];
        const offer = {
          id: createId(state, "off"),
          cardItemId: card.id,
          ebayOfferId: offerData.ebayOfferId,
          inventoryItemId: offerData.inventoryItemId,
          sku: offerData.sku,
          price: card.recommendedPrice,
          quantity: 1,
          isThickCard: Boolean(card.isThickCard),
          status: offerData.status,
          listingUrl: null,
          requestPayload: offerData.requestPayload || null,
          createdAt: nowIso(),
          updatedAt: nowIso()
        };
        state.offers.push(offer);
        created.push(offer);
      }
      createAuditEvent(state, "batch", batchId, "offers_created", { offerCount: created.length });
      return sendJson(res, 200, { batchId, offers: created });
    });
  }

  if (req.method === "POST" && pathname.startsWith("/api/batches/") && pathname.endsWith("/offers/update-prices")) {
    const batchId = pathname.split("/")[3];
    return withState(async (state) => {
      const offers = state.offers.filter((offer) => state.cardItems.some((card) => card.id === offer.cardItemId && card.batchId === batchId));
      const updated = await updateOfferPrices(offers);
      for (const item of updated) {
        const offer = state.offers.find((entry) => entry.id === item.id);
        if (offer) {
          offer.status = item.status;
          offer.updatedAt = nowIso();
          offer.syncedAt = item.syncedAt;
          offer.requestPayload = item.requestPayload || offer.requestPayload || null;
        }
      }
      createAuditEvent(state, "batch", batchId, "offers_updated", { offerCount: updated.length });
      return sendJson(res, 200, { batchId, offers: updated });
    });
  }

  if (req.method === "POST" && pathname.startsWith("/api/batches/") && pathname.endsWith("/publish")) {
    const batchId = pathname.split("/")[3];
    return withState(async (state) => {
      const offers = state.offers.filter((offer) => state.cardItems.some((card) => card.id === offer.cardItemId && card.batchId === batchId));
      const published = await publishOffers(offers);
      for (const item of published) {
        const offer = state.offers.find((entry) => entry.id === item.id);
        if (offer) {
          offer.status = item.status;
          offer.listingUrl = item.listingUrl;
          offer.updatedAt = nowIso();
          offer.publishedAt = item.publishedAt;
          offer.requestPayload = item.requestPayload || offer.requestPayload || null;
        }
        const card = state.cardItems.find((entry) => entry.id === item.cardItemId);
        if (card) {
          card.status = "listed";
          card.publishState = "published";
          card.updatedAt = nowIso();
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
      return notFound(res, "Image not found");
    }
  }

  return notFound(res);
}
