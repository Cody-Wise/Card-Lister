import { extractCardMetadata } from "../services/ocr.js";
import { matchCardIdentity } from "../services/matching.js";
import { getLiveCardComps } from "../services/comps.js";
import { calculatePrice } from "../services/pricing.js";
import { createAuditEvent, createId, nowIso, withState } from "../lib/store.js";
import { buildApifyLookupKey, hasApifyConfig, searchApifySoldListings } from "../services/apify.js";

function dedupeComps(comps) {
  const seen = new Set();
  const unique = [];
  for (const comp of comps) {
    const key = comp.listingId || comp.url || `${comp.title || "comp"}:${comp.totalPrice ?? comp.price ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(comp);
  }
  return unique;
}

export function choosePricingStrategy(metadata) {
  const hasExactVariant = Boolean(metadata?.parallel || metadata?.variantLabel);
  const hasAutograph = Boolean(metadata?.autographFlag);
  const hasNumberedHint = Boolean(metadata?.serialNumber || metadata?.printRun);
  if ((hasExactVariant || hasAutograph) && hasNumberedHint) {
    return "sold_comps_median";
  }
  if (hasNumberedHint) {
    return "sold_comps_p25";
  }
  return "sold_comps_p25";
}

async function processCardItemInState(state, cardItemId) {
  const cardItem = state.cardItems.find((item) => item.id === cardItemId);
  if (!cardItem) {
    throw new Error(`Card item not found: ${cardItemId}`);
  }

  const frontImage = state.cardImages.find((image) => image.id === cardItem.frontImageId);
  const backImage = state.cardImages.find((image) => image.id === cardItem.backImageId);
  const ocr = await extractCardMetadata({
    frontText: frontImage?.ocrText || "",
    backText: backImage?.ocrText || "",
    frontFileName: frontImage?.fileName || "",
    backFileName: backImage?.fileName || "",
    frontImagePath: frontImage?.storagePath || "",
    backImagePath: backImage?.storagePath || ""
  });

  const preserved = {
    playerName: cardItem.candidatePlayer || null,
    year: cardItem.candidateYear || null,
    setName: cardItem.candidateSetName || null,
    cardNumber: cardItem.candidateCardNumber || null,
    parallel: cardItem.candidateParallel || null,
    baseHint: Boolean(cardItem.candidateBaseHint),
    grade: cardItem.candidateGrade || null,
    gradedFlag: cardItem.candidateCondition === "graded",
    rookieFlag: Boolean(cardItem.candidateRookieFlag),
    autographFlag: Boolean(cardItem.candidateAutoHint),
    variantLabel: cardItem.candidateVariantLabel || null,
    serialNumber: cardItem.serialNumber || null,
    printRun: cardItem.printRun || null
  };
  const mergedOcr = {
    ...preserved,
    ...ocr,
    playerName: ocr.playerName ?? preserved.playerName,
    year: ocr.year ?? preserved.year,
    setName: ocr.setName ?? preserved.setName,
    cardNumber: ocr.cardNumber ?? preserved.cardNumber,
    parallel: ocr.parallel ?? preserved.parallel,
    baseHint: typeof ocr.baseHint === "boolean" ? ocr.baseHint : preserved.baseHint,
    grade: ocr.grade ?? preserved.grade,
    gradedFlag: typeof ocr.gradedFlag === "boolean" ? ocr.gradedFlag : preserved.gradedFlag,
    serialNumber: ocr.serialNumber ?? preserved.serialNumber,
    printRun: ocr.printRun ?? preserved.printRun,
    autographFlag: typeof ocr.autographFlag === "boolean" ? ocr.autographFlag : preserved.autographFlag
  };

  const match = matchCardIdentity(mergedOcr);
  let apifySoldComps = Array.isArray(cardItem.externalSoldComps) ? cardItem.externalSoldComps : [];
  const apifyLookupKey = buildApifyLookupKey(mergedOcr);
  if (hasApifyConfig() && (cardItem.apifyLookupKey !== apifyLookupKey || !apifySoldComps.length)) {
    try {
      const apifyResult = await searchApifySoldListings(mergedOcr);
      apifySoldComps = apifyResult.comps.slice(0, 10);
      cardItem.externalSoldComps = apifySoldComps;
      cardItem.apifyLookupKey = apifyLookupKey;
      cardItem.apifySearchKeywords = apifyResult.keywordsUsed || [];
      cardItem.apifySearchQuery = Array.isArray(apifyResult.keywordsUsed) ? apifyResult.keywordsUsed.join(" · ") : null;
      cardItem.externalCompSource = "apify";
      cardItem.externalCompUpdatedAt = nowIso();
      delete cardItem.apifyError;
    } catch (error) {
      cardItem.apifyError = error.message;
    }
  }
  const comps = await getLiveCardComps(
    mergedOcr,
    frontImage?.storagePath || null,
    backImage?.storagePath || null,
    match.canonicalCard,
    apifySoldComps
  );
  const pricingStrategy = choosePricingStrategy(mergedOcr);
  const soldComps = dedupeComps([...apifySoldComps, ...comps.sold]);
  const pricing = calculatePrice({
    soldComps,
    activeListings: comps.active,
    strategy: pricingStrategy
  });

  cardItem.candidatePlayer = mergedOcr.playerName;
  cardItem.candidateYear = mergedOcr.year;
  cardItem.candidateSetName = mergedOcr.setName;
  cardItem.candidateCardNumber = mergedOcr.cardNumber;
  cardItem.candidateParallel = mergedOcr.parallel;
  cardItem.candidateBaseHint = Boolean(mergedOcr.baseHint);
  cardItem.candidateAutoHint = Boolean(mergedOcr.autographFlag);
  cardItem.candidateGrade = mergedOcr.grade;
  cardItem.candidateCondition = mergedOcr.gradedFlag ? "graded" : "raw";
  cardItem.candidateRookieFlag = Boolean(mergedOcr.rookieFlag);
  cardItem.candidateVariantLabel = mergedOcr.variantLabel || null;
  cardItem.serialNumber = mergedOcr.serialNumber || null;
  cardItem.printRun = mergedOcr.printRun || null;
  cardItem.confidenceScore = Number(((mergedOcr.confidence + match.confidence) / 2).toFixed(2));
  cardItem.canonicalCardId = match.canonicalCard?.id || null;
  cardItem.recommendedPrice = pricing.recommendedPrice;
  cardItem.currency = "USD";
  cardItem.pricingStrategy = pricing.strategy;
  cardItem.pricingConfidence = pricing.confidence;
  cardItem.pricingReason = pricing.reason;
  cardItem.pricingEvidence = pricing.evidence;
  cardItem.marketDataSource = comps.active.some((comp) => comp.source === "browse_active") ? "ebay_browse" : "local";
  cardItem.ocrProvider = ocr.provider || (ocr.notes?.startsWith("OpenAI") ? "openai" : "heuristic");
  cardItem.ocrNotes = ocr.notes;
  cardItem.status = cardItem.confidenceScore < 0.65 ? "needs_review" : "priced";
  cardItem.updatedAt = nowIso();

  state.comps = state.comps.filter((comp) => comp.cardItemId !== cardItemId);
  for (const comp of [...comps.sold, ...comps.active]) {
    state.comps.push({
      id: createId(state, "comp"),
      cardItemId,
      source: comp.kind === "sold" ? comp.source : "browse_active",
      listingId: comp.id,
      title: comp.title,
      conditionLabel: comp.conditionLabel,
      salePrice: comp.salePrice ?? null,
      shippingPrice: comp.shippingPrice ?? null,
      totalPrice: comp.totalPrice ?? comp.price ?? null,
      soldAt: comp.soldAt ?? null,
      url: comp.url ?? null,
      matchScore: comp.matchScore ?? null,
      rawPayload: comp,
      createdAt: nowIso()
    });
  }

  createAuditEvent(state, "cardItem", cardItemId, "processed", {
    confidence: cardItem.confidenceScore,
    canonicalCardId: cardItem.canonicalCardId,
    recommendedPrice: cardItem.recommendedPrice
  });

  return cardItem;
}

export async function processCardItem(cardItemId) {
  return withState(async (state) => processCardItemInState(state, cardItemId));
}

export async function processBatch(batchId) {
  return withState(async (state) => {
    const batch = state.batches.find((entry) => entry.id === batchId);
    if (!batch) throw new Error(`Batch not found: ${batchId}`);

    batch.status = "processing";
    batch.updatedAt = nowIso();

    const cardItems = state.cardItems.filter((item) => item.batchId === batchId);
    for (const item of cardItems) {
      await processCardItemInState(state, item.id);
    }

    const refreshed = state.cardItems.filter((item) => item.batchId === batchId);
    const allReady = refreshed.every((item) => item.status === "priced" || item.status === "ready");
    batch.status = allReady ? "ready_to_publish" : "needs_review";
    batch.updatedAt = nowIso();

    createAuditEvent(state, "batch", batchId, "processed", {
      cardCount: cardItems.length,
      ready: allReady
    });

    return batch;
  });
}
