const serverStatus = document.getElementById("serverStatus");
const newBatchButton = document.getElementById("newBatchButton");
const createBatchButton = document.getElementById("createBatchButton");
const addCardRowButton = document.getElementById("addCardRowButton");
const uploadCardsButton = document.getElementById("uploadCardsButton");
const refreshButton = document.getElementById("refreshButton");
const loadEbaySetupButton = document.getElementById("loadEbaySetupButton");
  const exportStateButton = document.getElementById("exportStateButton");
  const importStateButton = document.getElementById("importStateButton");
  const cleanupListedCardsButton = document.getElementById("cleanupListedCardsButton");
  const importStateFile = document.getElementById("importStateFile");
  const stateMessage = document.getElementById("stateMessage");
const closeReviewButton = document.getElementById("closeReviewButton");
const importApifyButton = document.getElementById("importApifyButton");
const apifyTargetCard = document.getElementById("apifyTargetCard");
const apifyPayload = document.getElementById("apifyPayload");
const apifyMessage = document.getElementById("apifyMessage");
const activeBatchSelect = document.getElementById("activeBatchSelect");
const batchFilter = document.getElementById("batchFilter");
const batchesList = document.getElementById("batchesList");
const cardsList = document.getElementById("cardsList");
const reviewCardSelect = document.getElementById("reviewCardSelect");
const loadReviewCardButton = document.getElementById("loadReviewCardButton");
const reviewSummary = document.getElementById("reviewSummary");
const reviewPricingEvidence = document.getElementById("reviewPricingEvidence");
const reviewPlayerName = document.getElementById("reviewPlayerName");
const reviewSport = document.getElementById("reviewSport");
const reviewYear = document.getElementById("reviewYear");
const reviewSetName = document.getElementById("reviewSetName");
const reviewCardNumber = document.getElementById("reviewCardNumber");
const reviewParallel = document.getElementById("reviewParallel");
const reviewBrand = document.getElementById("reviewBrand");
const reviewMpn = document.getElementById("reviewMpn");
const reviewRookieMode = document.getElementById("reviewRookieMode");
const reviewPrintRun = document.getElementById("reviewPrintRun");
const reviewTeam = document.getElementById("reviewTeam");
const reviewLeague = document.getElementById("reviewLeague");
const reviewSerialNumber = document.getElementById("reviewSerialNumber");
const reviewCompGradeOverride = document.getElementById("reviewCompGradeOverride");
const reviewCompMatchMode = document.getElementById("reviewCompMatchMode");
const reviewBaseHint = document.getElementById("reviewBaseHint");
const reviewAutoHint = document.getElementById("reviewAutoHint");
const reviewThickCard = document.getElementById("reviewThickCard");
const reviewGrade = document.getElementById("reviewGrade");
const reviewGradingCompany = document.getElementById("reviewGradingCompany");
const reviewCertificationNumber = document.getElementById("reviewCertificationNumber");
const reviewNotes = document.getElementById("reviewNotes");
const saveReviewButton = document.getElementById("saveReviewButton");
const saveReviewAndProcessButton = document.getElementById("saveReviewAndProcessButton");
const approveReviewButton = document.getElementById("approveReviewButton");
const reviewMessage = document.getElementById("reviewMessage");
const generateReviewDescriptionButton = document.getElementById("generateReviewDescriptionButton");
const reviewDescription = document.getElementById("reviewDescription");
const loadEbayPreviewButton = document.getElementById("loadEbayPreviewButton");
const saveEbayListingButton = document.getElementById("saveEbayListingButton");
const createOfferFromReviewButton = document.getElementById("createOfferFromReviewButton");
const createAuctionOfferFromReviewButton = document.getElementById("createAuctionOfferFromReviewButton");
const publishOfferFromReviewButton = document.getElementById("publishOfferFromReviewButton");
const deleteOfferFromReviewButton = document.getElementById("deleteOfferFromReviewButton");
const ebayListingUrl = document.getElementById("ebayListingUrl");
const ebayListingUrlPlaceholder = document.getElementById("ebayListingUrlPlaceholder");
const ebayPreviewMessage = document.getElementById("ebayPreviewMessage");
const ebayListingMode = document.getElementById("ebayListingMode");
const ebayListingTitle = document.getElementById("ebayListingTitle");
const ebayListingCondition = document.getElementById("ebayListingCondition");
const ebayListingPrice = document.getElementById("ebayListingPrice");
const ebayAuctionStartPrice = document.getElementById("ebayAuctionStartPrice");
const ebayAuctionReservePrice = document.getElementById("ebayAuctionReservePrice");
const ebayAuctionBuyItNowPrice = document.getElementById("ebayAuctionBuyItNowPrice");
const ebayAuctionDuration = document.getElementById("ebayAuctionDuration");
const ebayBinFields = document.getElementById("ebayBinFields");
const ebayAuctionFields = document.getElementById("ebayAuctionFields");
const ebayCategoryId = document.getElementById("ebayCategoryId");
const ebaySpecifics = document.getElementById("ebaySpecifics");
const reviewOverlay = document.getElementById("reviewOverlay");
const cardRows = document.getElementById("cardRows");
const batchMessage = document.getElementById("batchMessage");
const uploadMessage = document.getElementById("uploadMessage");
const ebaySetupMessage = document.getElementById("ebaySetupMessage");
const ebaySetupOutput = document.getElementById("ebaySetupOutput");
const seedDataButton = document.getElementById("seedDataButton");
const seedMessage = document.getElementById("seedMessage");
const publishedList = document.getElementById("publishedList");
const salesRangePreset = document.getElementById("salesRangePreset");
const salesDays = document.getElementById("salesDays");
const salesStartDate = document.getElementById("salesStartDate");
const salesEndDate = document.getElementById("salesEndDate");
const salesSport = document.getElementById("salesSport");
const salesSportSort = document.getElementById("salesSportSort");
const salesLoadButton = document.getElementById("salesLoadButton");
const salesStatus = document.getElementById("salesStatus");
const salesSummary = document.getElementById("salesSummary");
const salesSportChart = document.getElementById("salesSportChart");
const salesResults = document.getElementById("salesResults");
const marketHeatDays = document.getElementById("marketHeatDays");
const marketHeatSport = document.getElementById("marketHeatSport");
const marketHeatLoadButton = document.getElementById("marketHeatLoadButton");
const marketHeatRefreshButton = document.getElementById("marketHeatRefreshButton");
const marketHeatExportButton = document.getElementById("marketHeatExportButton");
const marketHeatStatus = document.getElementById("marketHeatStatus");
const marketHeatSummary = document.getElementById("marketHeatSummary");
const marketHeatResults = document.getElementById("marketHeatResults");
const marketHeatDetail = document.getElementById("marketHeatDetail");
const listingSalesDays = document.getElementById("listingSalesDays");
const listingAgeFilter = document.getElementById("listingAgeFilter");
const listingSport = document.getElementById("listingSport");
const listingSearch = document.getElementById("listingSearch");
const listingSort = document.getElementById("listingSort");
const listingsLoadButton = document.getElementById("listingsLoadButton");
const listingsStatus = document.getElementById("listingsStatus");
const listingsSummary = document.getElementById("listingsSummary");
const listingsResults = document.getElementById("listingsResults");

const progressOverlay = document.getElementById("progressOverlay");
const progressFill = document.getElementById("progressFill");
const progressLabel = document.getElementById("progressLabel");
const progressPct = document.getElementById("progressPct");
const progressSub = document.getElementById("progressSub");
let driveImportPoll = null;

const marketHeatState = {
  report: null,
  selectedPlayerKey: "",
  playerInsights: Object.create(null),
};

const REVIEW_CARD_STORAGE_KEY = "cardLister.review.cardId";
const REVIEW_OVERLAY_STORAGE_KEY = "cardLister.review.open";
const GRADING_DRIVE_FOLDER_STORAGE_KEY = "cardLister.grading.folderId";

function readUiStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeUiStorage(key, value) {
  try {
    if (value == null || value === "") {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, String(value));
  } catch {}
}

function rememberReviewCard(cardId) {
  writeUiStorage(REVIEW_CARD_STORAGE_KEY, cardId || null);
}

function shouldRestoreReviewOverlay() {
  return readUiStorage(REVIEW_OVERLAY_STORAGE_KEY) === "1";
}

function setReviewOverlayRestore(value) {
  writeUiStorage(REVIEW_OVERLAY_STORAGE_KEY, value ? "1" : null);
}

function openReviewOverlay() {
  reviewOverlay.style.display = "flex";
  setReviewOverlayRestore(true);
}

function inferGradingCompanyFromGrade(value) {
  const raw = String(value || "").trim();
  const match = /^(PSA|BGS|SGC|CGC|CSG|BVG|BCCG|HGA)\b/i.exec(raw);
  return match ? match[1].toUpperCase() : "";
}

let state = { batches: [], cardItems: [] };
let reviewState = { cardId: readUiStorage(REVIEW_CARD_STORAGE_KEY) || null, details: null };

let driveState = {
  connected: false, configured: false, folderId: "", pairs: [], unmatched: [], selected: new Set(),
};

const driveConnectButton = document.getElementById("driveConnectButton");
const driveDisconnectButton = document.getElementById("driveDisconnectButton");
const driveStatus = document.getElementById("driveStatus");
const driveFolderId = document.getElementById("driveFolderId");
const driveScanButton = document.getElementById("driveScanButton");
const driveScanMessage = document.getElementById("driveScanMessage");
const driveResults = document.getElementById("driveResults");
const driveSummary = document.getElementById("driveSummary");
const drivePairsList = document.getElementById("drivePairsList");
const driveImportButton = document.getElementById("driveImportButton");
const driveImportMessage = document.getElementById("driveImportMessage");

let gradingState = { pairs: [], unmatched: [], selected: new Set(), items: [], pollTimer: null };
// Set from /api/bootstrap's gradingFeatureEnabled on every refresh() — the
// grading feature is disabled by default (2026-07-04, Ximilar's results
// weren't reliable enough) pending a different provider. Hides the nav tab,
// its tab content, and every "Send to Grading" button; the server-side
// routes are gated independently too (see src/routes/grading-routes.js and
// the /send-to-grading route in src/app.js).
let gradingFeatureEnabled = false;

const daCardWorldRefreshButton = document.getElementById("daCardWorldRefreshButton");
const daCardWorldStatus = document.getElementById("daCardWorldStatus");
const daCardWorldUpdatedAt = document.getElementById("daCardWorldUpdatedAt");
const daCardWorldNewReleases = document.getElementById("daCardWorldNewReleases");
const daCardWorldDeals = document.getElementById("daCardWorldDeals");

const gradingRefreshButton = document.getElementById("gradingRefreshButton");
const gradingDriveFolderId = document.getElementById("gradingDriveFolderId");
gradingDriveFolderId.value = readUiStorage(GRADING_DRIVE_FOLDER_STORAGE_KEY) || "";
gradingDriveFolderId.addEventListener("change", () => {
  writeUiStorage(GRADING_DRIVE_FOLDER_STORAGE_KEY, gradingDriveFolderId.value.trim());
});
const gradingDriveScanButton = document.getElementById("gradingDriveScanButton");
const gradingDriveScanMessage = document.getElementById("gradingDriveScanMessage");
const gradingDriveResults = document.getElementById("gradingDriveResults");
const gradingDriveSummary = document.getElementById("gradingDriveSummary");
const gradingDrivePairsList = document.getElementById("gradingDrivePairsList");
const gradingDriveImportButton = document.getElementById("gradingDriveImportButton");
const gradingDriveImportMessage = document.getElementById("gradingDriveImportMessage");
const gradingItemsList = document.getElementById("gradingItemsList");
const sentToGradingList = document.getElementById("sentToGradingList");
const sendToGradingButton = document.getElementById("sendToGradingButton");

function getApiOrigins() {
  const isValidHttpProtocol = /^https?:/i.test(window.location.protocol);
  const host = isValidHttpProtocol ? window.location.hostname : "localhost";
  const protocol = isValidHttpProtocol ? window.location.protocol : "http:";
  const fallback = [];
  const isLocalHost = ["127.0.0.1", "localhost"].includes(host);
  if (isValidHttpProtocol) {
    fallback.push(window.location.origin);
  }
  const candidatePorts = isLocalHost
    ? ["3000"]
    : [];
  for (const fallbackPort of candidatePorts) {
    const sameHostFallback = `${protocol}//${host}:${fallbackPort}`;
    if (!fallback.includes(sameHostFallback)) {
      fallback.push(sameHostFallback);
    }
  }
  const localhostAliases = ["127.0.0.1", "localhost"];
  for (const fallbackHost of localhostAliases) {
    if (fallbackHost === host) continue;
    for (const fallbackPort of candidatePorts) {
      const alternateFallback = `${protocol}//${fallbackHost}:${fallbackPort}`;
      if (!fallback.includes(alternateFallback)) {
        fallback.push(alternateFallback);
      }
    }
  }
  return fallback;
}

async function api(path, options = {}) {
  const origins = getApiOrigins();
  const normalizedOptions = {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    credentials: "include",
    ...options,
  };
  let lastError;
  for (let index = 0; index < origins.length; index += 1) {
    const origin = origins[index];
    const baseUrl = origin === "" ? path : `${origin}${path}`;
    try {
      const response = await fetch(baseUrl, normalizedOptions);
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      const raw = await response.text();
      let data = null;
      if (raw) {
        if (contentType.includes("application/json")) {
          data = JSON.parse(raw);
        } else {
          const trimmed = raw.trim();
          const looksHtml = trimmed.startsWith("<!doctype") || trimmed.startsWith("<html");
          if (looksHtml) {
            if (response.redirected || response.url.includes("/login.html")) {
              throw new Error(`Received HTML login page from ${baseUrl}. Refresh and sign in again.`);
            }
            throw new Error(`Received HTML instead of JSON from ${baseUrl}. Restart the dev server and hard refresh the page.`);
          }
          try {
            data = JSON.parse(raw);
          } catch {
            throw new Error(`Unexpected non-JSON response from ${baseUrl}: ${trimmed.slice(0, 120)}`);
          }
        }
      }
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    } catch (error) {
      lastError = error;
      const isNetworkError = error instanceof TypeError && /Failed to fetch/i.test(error.message);
      if (!isNetworkError || index === origins.length - 1) {
        throw error;
      }
    }
  }
  throw lastError;
}

function showProgress(label, pct, sub) {
  progressOverlay.style.display = "flex";
  progressLabel.textContent = label;
  progressFill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  progressPct.textContent = `${Math.round(pct)}%`;
  progressSub.textContent = sub || "";
}

function hideProgress() {
  progressOverlay.style.display = "none";
}

function dismissProgress() {
  if (driveImportPoll) {
    clearInterval(driveImportPoll);
    driveImportPoll = null;
    driveImportMessage.textContent = "Processing is continuing in the background. Refresh or reload cards in a moment.";
  }
  hideProgress();
}

function makeCardRow() {
  const row = document.createElement("div");
  row.className = "card-row";
  row.innerHTML = `
    <label>Front <input type="file" accept="image/*" data-side="front" /></label>
    <label>Back <input type="file" accept="image/*" data-side="back" /></label>
    <label>Notes <input type="text" placeholder="hint" data-side="notes" /></label>
    <label>Run <input type="text" placeholder="75" data-side="printRun" /></label>
    <label>Parallel <input type="text" placeholder="Gold" data-side="parallel" /></label>
    <label class="check-row checkbox-field"><input type="checkbox" data-side="base" /> Base</label>
    <label class="check-row checkbox-field"><input type="checkbox" data-side="auto" /> Auto</label>
    <label class="check-row checkbox-field"><input type="checkbox" data-side="thick" /> Thick</label>
  `;
  return row;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function renderBatchSelect() {
  activeBatchSelect.innerHTML = state.batches
    .map((b) => `<option value="${b.id}">${b.id} - ${b.status}</option>`).join("");
}

function renderApifyTargetSelect() {
  apifyTargetCard.innerHTML = state.cardItems
    .map((c) => {
      const l = `${c.id} · ${c.candidatePlayer || "Unknown"} · ${c.candidateYear || "----"} · ${c.candidateCardNumber || "?"}`;
      return `<option value="${c.id}">${l}</option>`;
    }).join("");
}

function rookieModeFromCard(card) {
  if (!card?.candidateRookieFlag) return "none";
  return /rated rookie/i.test(card.candidateVariantLabel || "") ? "rated" : "generic";
}

function reviewCardLabel(card) {
  return `${card.id} · ${card.candidatePlayer || "Unknown"} · ${card.candidateYear || "----"} · ${card.candidateSetName || "Unknown set"} · ${card.candidateCardNumber || "?"}`;
}

function money(v) {
  if (v == null || Number.isNaN(Number(v))) return "n/a";
  return `$${Number(v).toFixed(2)}`;
}

function parseMoneyInput(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  const cleaned = normalized.replace(/[$,\s]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function getReviewEbayListingConfig() {
  const mode = ebayListingMode?.value === "auction" ? "AUCTION" : "FIXED_PRICE";
  if (mode === "AUCTION") {
    return {
      ebayListingFormat: "AUCTION",
      ebayAuctionStartPrice: parseMoneyInput(ebayAuctionStartPrice.value),
      ebayAuctionReservePrice: parseMoneyInput(ebayAuctionReservePrice.value),
      ebayAuctionBuyItNowPrice: parseMoneyInput(ebayAuctionBuyItNowPrice.value),
      ebayAuctionDuration: ebayAuctionDuration.value || "DAYS_7",
    };
  }

  return {
    ebayListingFormat: "FIXED_PRICE",
    ebayAuctionStartPrice: null,
    ebayAuctionReservePrice: null,
    ebayAuctionBuyItNowPrice: null,
    ebayAuctionDuration: null,
  };
}

function applyEbayListingMode(mode) {
  const isAuction = mode === "AUCTION";
  if (ebayListingMode) ebayListingMode.value = isAuction ? "auction" : "fixed";
  if (ebayBinFields) ebayBinFields.style.display = isAuction ? "none" : "block";
  if (ebayAuctionFields) ebayAuctionFields.style.display = isAuction ? "block" : "none";
  if (createOfferFromReviewButton) createOfferFromReviewButton.textContent = "Create buy it now offer";
}

function formatCompSourceLabel(source) {
  const normalized = String(source || "").toLowerCase();
  // "apify" covers cards priced before the switch to SoldComps; both show
  // the same label since they're the same "direct eBay sold-search" concept.
  if (normalized.startsWith("apify") || normalized.startsWith("soldcomps")) return "SoldComps";
  if (normalized === "browse_active") return "eBay Browse";
  return source || "unknown";
}

function normalizeReviewIdentityText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function reviewListingLooksStale(card = {}) {
  const haystack = normalizeReviewIdentityText(
    `${card.ebayTitle || ""} ${card.ebayDescription || ""} ${JSON.stringify(card.ebaySpecifics || {})}`,
  );
  if (!haystack) return true;
  const playerTokens = normalizeReviewIdentityText(card.candidatePlayer || card.playerName || "")
    .split(" ")
    .filter((token) => token.length > 2);
  if (playerTokens.length && !playerTokens.some((token) => haystack.includes(token))) {
    return true;
  }
  return false;
}

function renderCompList(title, comps, emptyLabel, cardId, excludedIds, maxItems = 50) {
  const allRows = Array.isArray(comps) ? comps : [];
  const rows = allRows.slice(0, maxItems);
  const heading = allRows.length > rows.length
    ? `${title} (showing ${rows.length} of ${allRows.length})`
    : `${title} (${allRows.length})`;
  const items = rows.length
    ? rows.map((comp) => {
        const compKey = comp.listingId || comp.url || comp.title;
        const excluded = excludedIds && compKey ? excludedIds.has(compKey) : false;
        return `<div class="evidence-item ${excluded ? "excluded" : ""}">
          <div class="evidence-title">${comp.title || "Unknown comp"}</div>
          <div class="muted">${formatCompSourceLabel(comp.source)} · ${money(comp.totalPrice ?? comp.price ?? comp.salePrice)}${comp.soldAt ? ` · ${comp.soldAt.slice(0, 10)}` : ""}${comp.matchScore != null ? ` · score: ${comp.matchScore.toFixed(2)}` : ""}</div>
          ${comp.url ? `<div class="evidence-url"><a href="${comp.url}" target="_blank" rel="noreferrer">Open listing</a></div>` : ""}
          ${cardId && compKey ? `<label class="comp-toggle"><input type="checkbox" data-card-id="${cardId}" data-comp-key="${compKey}" ${excluded ? "" : "checked"} /> Include</label>` : ""}
        </div>`;
      }).join("")
    : `<div class="muted">${emptyLabel}</div>`;
  return `<div class="evidence-column"><h3>${heading}</h3><div class="evidence-list">${items}</div></div>`;
}

function renderReviewCardSelect() {
  const filterBatch = batchFilter.value;
  const candidates = filterBatch
    ? state.cardItems.filter((c) => c.batchId === filterBatch)
    : state.cardItems;
  const preferred = reviewState.cardId && candidates.some((c) => c.id === reviewState.cardId)
    ? reviewState.cardId
    : candidates.find((c) => c.status === "needs_review" && c.marketDataSource !== "seed")?.id ||
      candidates.find((c) => c.status === "needs_review")?.id ||
      candidates[0]?.id || "";
  if (preferred && preferred !== reviewState.cardId) reviewState.cardId = preferred;
  reviewCardSelect.innerHTML = candidates
    .map((c) => `<option value="${c.id}">${reviewCardLabel(c)}</option>`).join("");
  if (preferred) reviewCardSelect.value = preferred;
}

function renderReviewSummary(detail) {
  if (!detail) {
    reviewSummary.textContent = "Select a card to inspect and edit.";
    reviewPricingEvidence.innerHTML = "";
    document.getElementById("reviewImages").innerHTML = "";
    return;
  }
  const { card, comps: stateComps, externalSoldComps } = detail;
  const pe = card.pricingEvidence || {};
  const excludedIds = new Set(card.excludedCompIds || []);
  const soldComps = Array.isArray(externalSoldComps) ? externalSoldComps : [];
  const activeComps = Array.isArray(stateComps)
    ? stateComps.filter((c) => c.source === "browse_active")
    : [];
  const soldCount = Array.isArray(externalSoldComps) ? externalSoldComps.length : 0;
  const activeCount = Array.isArray(stateComps)
    ? stateComps.filter((c) => c.source === "browse_active").length : 0;
  const weightLines = [];
  if (pe.blendApplied && pe.soldWeight != null) {
    weightLines.push(`Sold weight: ${Math.round(pe.soldWeight * 100)}% · Active weight: ${Math.round(pe.activeWeight * 100)}%`);
  }
  if (pe.soldAnchor != null) weightLines.push(`Sold anchor: ${money(pe.soldAnchor)}`);
  if (pe.soldMedian != null) weightLines.push(`Sold median: ${money(pe.soldMedian)} · P25: ${money(pe.soldP25)}`);
  if (pe.activeMedian != null) weightLines.push(`Active median: ${money(pe.activeMedian)} · P25: ${money(pe.activeP25)} · floor: ${money(pe.activeFloor)}`);
  const soldCompSourceValue = String(card.compMatchProvider || card.externalCompSource || "").toLowerCase();
  const isApifySource = soldCompSourceValue === "apify" || soldCompSourceValue === "soldcomps";
  const batch = state.batches.find((b) => b.id === card.batchId);
  const gradedSummary = [
    card.candidateGrade ? `Grade: ${card.candidateGrade}` : null,
    card.gradingCompany ? `Grader: ${card.gradingCompany}` : null,
    card.certificationNumber ? `Cert #: ${card.certificationNumber}` : null,
  ].filter(Boolean).join(" · ");
  const lines = [
    `${card.id} · Batch: ${card.batchId}${batch ? ` (${batch.source})` : ""}`,
    `${card.candidatePlayer || "Unknown"} · ${card.candidateYear || "----"} · ${card.candidateSetName || "Unknown set"} · ${card.candidateCardNumber || "?"}`,
    `Price: ${card.recommendedPrice == null ? "n/a" : `$${card.recommendedPrice.toFixed(2)}`} · Confidence: ${Math.round((card.confidenceScore || 0) * 100)}%`,
    `Status: ${card.status || "n/a"} · Market: ${card.marketDataSource || "n/a"} · Identity OCR: ${card.identityProvider || card.ocrProvider || "n/a"}`,
    ...(card.identityDisagreement
      ? [`⚠ DISAGREEMENT — ${card.identityDisagreement.field}: Ximilar says "${card.identityDisagreement.ximilar}", OpenAI says "${card.identityDisagreement.openai}". Verify before approving.`]
      : []),
    `Base: ${card.candidateBaseHint ? "Yes" : "No"} · Auto: ${card.candidateAutoHint ? "Yes" : "No"} · Rookie: ${rookieModeFromCard(card)} · Parallel: ${card.candidateParallel || "n/a"}`,
    `Print run: ${card.printRun || "n/a"}${card.serialNumber ? ` · Serial: ${card.serialNumber}` : ""} · Parallel source: ${card.parallelProvider || "n/a"} · Comp grade: ${card.compGradeOverride || "Auto detect"} · Comp match: ${card.compMatchMode || "auto"}`,
    gradedSummary || "Grade: n/a",
    `Sold comps: ${soldCount} · Active: ${activeCount}`,
    ...(isApifySource && card.apifySearchQuery ? [`Comp search query: ${card.apifySearchQuery}`] : []),
    ...(weightLines.length ? [`Pricing: ${weightLines.join(" · ")}`] : []),
    ...(card.pricingReason ? [`Reason: ${card.pricingReason}`] : []),
  ];
  reviewSummary.textContent = lines.join("\n");
  reviewPricingEvidence.innerHTML = `
    ${renderCompList("Sold comps pulled", soldComps, "No sold comps stored.", card.id, excludedIds, 50)}
    ${renderCompList("Active listings pulled", activeComps, "No active listings stored.", card.id, excludedIds, 50)}
  `;
}

async function loadReviewCard(cardId = reviewCardSelect.value) {
  if (!cardId) {
    reviewState.cardId = null; reviewState.details = null;
    renderReviewSummary(null);
    return;
  }
  reviewDescription.value = "";
  ebayListingTitle.value = "";
  ebaySpecifics.innerHTML = `<div class="muted">Loading eBay preview...</div>`;
  const detail = await api(`/api/card-items/${cardId}`);
  reviewState.cardId = cardId;
  rememberReviewCard(cardId);
  reviewState.details = detail;
  const { card, images } = detail;
  // "Send to Grading" only makes sense for a card that isn't already live on
  // eBay — normalizeState() in src/lib/store.js forces status/publishState
  // back to listed/published for anything with a real listingUrl, so
  // clicking it on an already-published card would be a confusing no-op.
  const isPublished = card.status === "listed" || card.publishState === "published" || Boolean(card.listingUrl);
  sendToGradingButton.style.display = isPublished || !gradingFeatureEnabled ? "none" : "";
  const el = document.getElementById("reviewImages");
  if (images && images.length) {
    const sorted = [...images].sort((a, b) => a.side === "front" ? -1 : b.side === "front" ? 1 : 0);
    el.innerHTML = sorted.map((img) => `<img src="${img.url}" alt="${img.side}" />`).join("");
  } else {
    el.innerHTML = `<div class="muted">No images</div>`;
  }
  reviewPlayerName.value = card.candidatePlayer || "";
  reviewSport.value = card.candidateSport || "";
  reviewYear.value = card.candidateYear || "";
  reviewSetName.value = card.candidateSetName || "";
  reviewCardNumber.value = card.candidateCardNumber || "";
  reviewParallel.value = card.candidateParallel || "";
  reviewBrand.value = card.candidateBrand || "";
  reviewMpn.value = card.mpn || "";
  reviewRookieMode.value = rookieModeFromCard(card);
  reviewPrintRun.value = card.printRun || "";
  reviewTeam.value = card.candidateTeam || "";
  reviewLeague.value = card.candidateLeague || "";
  reviewSerialNumber.value = card.serialNumber || "";
  reviewGradingCompany.value = card.gradingCompany || inferGradingCompanyFromGrade(card.candidateGrade);
  reviewCertificationNumber.value = card.certificationNumber || "";
  if (reviewCompGradeOverride) reviewCompGradeOverride.value = card.compGradeOverride || "";
  if (reviewCompMatchMode) reviewCompMatchMode.value = card.compMatchMode || "auto";
  reviewBaseHint.checked = Boolean(card.candidateBaseHint);
  reviewAutoHint.checked = Boolean(card.candidateAutoHint);
  reviewThickCard.checked = Boolean(card.isThickCard);
  reviewGrade.value = card.candidateGrade || "";
  reviewNotes.value = card.notes || "";
  const needsFreshPreview = reviewListingLooksStale(card);
  reviewDescription.value = needsFreshPreview ? "" : card.ebayDescription || "";
  ebayListingTitle.value = needsFreshPreview ? "" : card.ebayTitle || "";
  ebayListingCondition.value = card.candidateCondition === "graded" ? "LIKE_NEW" : "USED_VERY_GOOD";
  ebayListingPrice.value = card.recommendedPrice ?? "";
  ebayCategoryId.value = card.ebayCategoryId || "";
  applyEbayListingMode(card.ebayListingFormat === "AUCTION" ? "AUCTION" : "FIXED_PRICE");
  if (ebayAuctionStartPrice) {
    ebayAuctionStartPrice.value =
      card.ebayAuctionStartPrice != null
        ? String(card.ebayAuctionStartPrice)
        : card.recommendedPrice != null
          ? String(card.recommendedPrice)
          : "";
  }
  if (ebayAuctionReservePrice) ebayAuctionReservePrice.value = card.ebayAuctionReservePrice ?? "";
  if (ebayAuctionBuyItNowPrice) ebayAuctionBuyItNowPrice.value = card.ebayAuctionBuyItNowPrice ?? "";
  if (ebayAuctionDuration) ebayAuctionDuration.value = card.ebayAuctionDuration || "DAYS_7";
  if (card.ebaySpecifics && !needsFreshPreview) {
    renderEbaySpecifics(card.ebaySpecifics);
  } else {
    ebaySpecifics.textContent = "Loading eBay preview...";
    loadEbayPreview(cardId, card, { force: needsFreshPreview });
  }
  deleteOfferFromReviewButton.style.display = detail.offer ? "" : "none";
  if (detail.offer) deleteOfferFromReviewButton.textContent = `Delete offer (${detail.offer.status})`;
  // Was checking offer.status === "created" — a real, fully-created offer's
  // status is "priced" (see /api/card-items/:id/offers/create), never
  // literally "created", so this never matched and the button stayed
  // hidden regardless of whether the offer was actually publishable.
  // Matches the card-grid's canPublishOffer check instead: a real eBay
  // offer exists and hasn't been published yet.
  publishOfferFromReviewButton.style.display =
    detail.offer && detail.offer.ebayOfferId && !detail.offer.listingUrl ? "" : "none";
  if (detail.offer?.listingUrl) {
    ebayListingUrl.href = detail.offer.listingUrl;
    ebayListingUrl.textContent = detail.offer.listingUrl;
    ebayListingUrl.style.display = "";
    ebayListingUrlPlaceholder.style.display = "none";
  } else {
    ebayListingUrl.style.display = "none";
    ebayListingUrlPlaceholder.style.display = "";
  }
  renderReviewSummary(detail);
}

function buildReviewPayload() {
  const grade = reviewGrade.value;
  const rawConditions = ["Near Mint or Better", "Excellent", "Very Good", "Poor"];
  const gradingCompany = reviewGradingCompany.value.trim();
  const certificationNumber = reviewCertificationNumber.value.trim();
  const isGraded = Boolean((grade && !rawConditions.includes(grade)) || gradingCompany || certificationNumber);
  const price = parseFloat(ebayListingPrice.value);
  return {
    playerName: reviewPlayerName.value,
    sport: reviewSport.value || null,
    year: reviewYear.value,
    setName: reviewSetName.value,
    cardNumber: reviewCardNumber.value,
    parallel: reviewParallel.value,
    brand: reviewBrand.value,
    mpn: reviewMpn.value,
    rookieMode: reviewRookieMode.value,
    printRun: reviewPrintRun.value,
    team: reviewTeam.value,
    league: reviewLeague.value,
    serialNumber: reviewSerialNumber.value,
    compGradeOverride: reviewCompGradeOverride?.value || "",
    compMatchMode: reviewCompMatchMode?.value || "auto",
    baseHint: reviewBaseHint.checked,
    autographHint: reviewAutoHint.checked,
    thickCard: reviewThickCard.checked,
    grade: reviewGrade.value,
    gradingCompany,
    certificationNumber,
    isGraded,
    candidateCondition: isGraded ? "graded" : "raw",
    recommendedPrice: isNaN(price) || price <= 0 ? undefined : price,
    notes: reviewNotes.value,
  };
}

function getReviewEbayPayload() {
  return getReviewEbayListingConfig();
}

async function saveReview({ reprocess = false } = {}) {
  const cardId = reviewCardSelect.value;
  if (!cardId) throw new Error("Select a card to review.");
  reviewMessage.textContent = reprocess ? "Saving and reprocessing..." : "Saving...";
  const path = reprocess ? `/api/card-items/${cardId}/review` : `/api/card-items/${cardId}`;
  const method = reprocess ? "POST" : "PATCH";
  await api(path, { method, body: JSON.stringify(buildReviewPayload()) });
  reviewMessage.textContent = reprocess ? `Saved and reprocessed ${cardId}` : `Saved ${cardId}`;
  await refresh();
  reviewCardSelect.value = cardId;
  await loadReviewCard(cardId);
  reviewDescription.value = "";
  await loadEbayPreview(cardId, state.cardItems.find((c) => c.id === cardId));
}

function statusBadge(status) {
  const cls = status === "published" || status === "listed" || status === "priced" || status === "ready"
    ? "badge good"
    : status === "needs_review" || status === "draft"
      ? "badge warn"
      : status === "error" ? "badge bad" : "badge";
  return `<span class="${cls}">${status}</span>`;
}

// Ximilar and OpenAI run in parallel on every card as an identity
// cross-check; when they disagree, ocr.js/pipeline.js records it structurally
// on card.identityDisagreement instead of only burying it in ocrNotes text —
// surface it here so a reviewer sees the conflict without opening notes.
function disagreementBadge(card) {
  const d = card.identityDisagreement;
  if (!d) return "";
  const label = `${d.field}: Ximilar "${d.ximilar}" vs OpenAI "${d.openai}"`;
  return `<span class="badge bad" title="${label.replace(/"/g, "&quot;")}">⚠ Ximilar/OpenAI disagree</span>`;
}

function renderBatches() {
  if (!state.batches.length) {
    batchesList.innerHTML = `<div class="empty-state">No batches yet.</div>`;
    return;
  }
  batchesList.innerHTML = state.batches.map((batch) => {
    const count = state.cardItems.filter((c) => c.batchId === batch.id).length;
    const cl = batch.publishChecklist || [];
    const clHtml = cl.length ? `<div class="checklist">
      ${cl.map((item, idx) => `<label class="check-label checklist-item"><input type="checkbox" data-action="toggle-checklist" data-id="${batch.id}" data-idx="${idx}" ${item.checked ? "checked" : ""} /> ${item.label}</label>`).join("")}
    </div>` : "";
    return `<div class="item">
      <div class="item-head">
        <div><strong>${batch.id}</strong><div class="muted batch-metadata">${batch.source} · ${count} cards</div></div>
        <div class="card-item-actions batch-actions">
          ${statusBadge(batch.status)}
          <button class="btn btn-sm btn-outline" data-action="process-batch" data-id="${batch.id}">Process</button>
          <button class="btn btn-sm btn-outline" data-action="create-offers" data-id="${batch.id}">Offers</button>
          <button class="btn btn-sm btn-outline" data-action="update-prices" data-id="${batch.id}">Prices</button>
          <button class="btn btn-sm" data-action="publish-batch" data-id="${batch.id}">Publish</button>
        </div>
      </div>
      <div class="muted batch-notes">${batch.notes || ""}</div>
      ${clHtml}
    </div>`;
  }).join("");
}

function formatDateLabel(dateStr) {
  if (!dateStr) return "Unknown date";
  const d = new Date(dateStr);
  const opts = { month: "long", day: "numeric", year: "numeric" };
  return `Published ${d.toLocaleDateString("en-US", opts)}`;
}

function renderPublishedCards() {
  const offers = state.offers || [];
  const publishedOffers = offers.filter((o) =>
    o.status === "published" || o.status === "active" || o.listingUrl
  );
  const publishedCards = state.cardItems.filter((c) =>
    c.status === "listed" || c.publishState === "published"
  );

  if (!publishedOffers.length && !publishedCards.length) {
    publishedList.innerHTML = `<div class="empty-state">No cards published yet.</div>`;
    return;
  }

  const groups = {};

  for (const offer of publishedOffers) {
    const card = state.cardItems.find((c) => c.id === offer.cardItemId);
    const dateKey = (offer.publishedAt || offer.updatedAt || offer.createdAt || "").slice(0, 10);
    if (!groups[dateKey]) groups[dateKey] = [];
    groups[dateKey].push({ card, offer });
  }

  for (const card of publishedCards) {
    const already = Object.values(groups).some((g) =>
      g.some((e) => e.card?.id === card.id)
    );
    if (!already) {
      const dateKey = (card.updatedAt || card.createdAt || "").slice(0, 10);
      if (!groups[dateKey]) groups[dateKey] = [];
      groups[dateKey].push({ card, offer: null });
    }
  }

  const sortedKeys = Object.keys(groups).sort((a, b) => b.localeCompare(a));

  publishedList.innerHTML = sortedKeys.map((key) => {
    const label = key ? formatDateLabel(key) : "Unknown date";
    const entries = groups[key];
    return `<details class="published-folder" ${key === sortedKeys[0] ? "open" : ""}>
      <summary>
        <div class="published-folder-header">
          <div class="published-folder-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            ${label}
            <span class="published-folder-count">${entries.length} card${entries.length !== 1 ? "s" : ""}</span>
          </div>
          <div class="published-folder-chevron"></div>
        </div>
      </summary>
      <div class="published-folder-body">
        ${entries.map(({ card, offer }) => {
          const title = [card?.candidateYear, card?.candidatePlayer, card?.candidateCardNumber].filter(Boolean).join(" · ") || card?.id || "Unknown";
          const url = offer?.listingUrl || card?.listingUrl;
          return `<div class="published-card" data-card-id="${card?.id || ""}">
            <div class="published-card-title">${title}</div>
            ${url ? `<a class="published-card-url" href="${url}" target="_blank" rel="noopener">${url}</a>` : `<span class="muted">No URL</span>`}
            <div class="published-card-meta">${card?.candidateSetName || ""}${card?.candidateParallel ? ` · ${card.candidateParallel}` : ""} · ${money(card?.recommendedPrice)}</div>
          </div>`;
        }).join("")}
      </div>
    </details>`;
  }).join("");
}

function formatListingDays(days) {
  if (!Number.isFinite(days)) return "Age unknown";
  if (days === 0) return "Listed today";
  if (days === 1) return "Listed 1 day ago";
  return `Listed ${days} days ago`;
}

function listingAgeFilterLabel(value) {
  const raw = String(value || "");
  if (!raw) return "Any age";
  const option = listingAgeFilter?.querySelector(`option[value="${raw}"]`);
  return option?.textContent || "Custom age filter";
}

function listingRepricingStatusLabel(repricing) {
  const status = String(repricing?.status || "unavailable");
  if (status === "overpriced") return "Above comp range";
  if (status === "underpriced") return "Below comp range";
  if (status === "aligned") return "In comp range";
  return "Pricing signal unavailable";
}

function listingRepricingSourceLabel(source) {
  const normalized = String(source || "").toLowerCase();
  if (normalized === "ebay_image_search") return "eBay comps";
  if (normalized.startsWith("apify") || normalized.startsWith("soldcomps")) return "SoldComps";
  return "Suggested";
}

function listingRepricingPill(repricing) {
  if (!repricing) return "Pricing signal unavailable";
  const sourceLabel = listingRepricingSourceLabel(repricing.source);
  const delta = Number.isFinite(repricing.deltaAmount)
    ? `${repricing.deltaAmount >= 0 ? "+" : "-"}${formatSalesMoney(Math.abs(repricing.deltaAmount))}`
    : null;
  return [sourceLabel, listingRepricingStatusLabel(repricing), delta].filter(Boolean).join(" · ");
}

function listingRepricingRangeLabel(repricing) {
  if (!repricing || (!Number.isFinite(repricing.low) && !Number.isFinite(repricing.high))) {
    return "No range";
  }
  if (Number.isFinite(repricing.low) && Number.isFinite(repricing.high)) {
    return `${formatSalesMoney(repricing.low)} - ${formatSalesMoney(repricing.high)}`;
  }
  if (Number.isFinite(repricing.low)) return `From ${formatSalesMoney(repricing.low)}`;
  return `Up to ${formatSalesMoney(repricing.high)}`;
}

function listingRepricingDeltaLabel(repricing) {
  if (!repricing || !Number.isFinite(repricing.deltaAmount) || !Number.isFinite(repricing.deltaPct)) {
    return "No delta";
  }
  const sign = repricing.deltaAmount >= 0 ? "+" : "-";
  return `${sign}${formatSalesMoney(Math.abs(repricing.deltaAmount))} · ${sign}${Math.round(Math.abs(repricing.deltaPct) * 100)}%`;
}

function renderListingsDashboard(data) {
  if (!listingsResults) return;
  const summary = data?.summary || {};
  const listings = Array.isArray(data?.listings) ? data.listings : [];

  if (listingsSummary) {
    listingsSummary.innerHTML = `
      <div class="listing-summary-card">
        <span class="listing-summary-label">Active listings</span>
        <strong>${summary.totalListings || 0}</strong>
      </div>
      <div class="listing-summary-card">
        <span class="listing-summary-label">Live value</span>
        <strong>${formatSalesMoney(summary.totalValue || 0)}</strong>
      </div>
      <div class="listing-summary-card">
        <span class="listing-summary-label">Avg. days listed</span>
        <strong>${summary.averageDaysListed || 0}</strong>
      </div>
      <div class="listing-summary-card">
        <span class="listing-summary-label">Best offer on</span>
        <strong>${summary.withBestOffer || 0}</strong>
      </div>
      <div class="listing-summary-card">
        <span class="listing-summary-label">Orders ${data?.analyticsWindowDays || 90}d</span>
        <strong>${summary.accountSalesOrdersInWindow || 0}</strong>
      </div>
      <div class="listing-summary-card">
        <span class="listing-summary-label">Items sold ${data?.analyticsWindowDays || 90}d</span>
        <strong>${summary.accountSoldUnitsInWindow || 0}</strong>
      </div>
      <div class="listing-summary-card">
        <span class="listing-summary-label">Revenue ${data?.analyticsWindowDays || 90}d</span>
        <strong>${formatSalesMoney(summary.accountSoldRevenueInWindow || 0)}</strong>
      </div>
      <div class="listing-summary-card">
        <span class="listing-summary-label">Matched active sales ${data?.analyticsWindowDays || 90}d</span>
        <strong>${summary.soldUnitsInWindow || 0} · ${formatSalesMoney(summary.soldRevenueInWindow || 0)}</strong>
      </div>
      <div class="listing-summary-card">
        <span class="listing-summary-label">Repricing flags</span>
        <strong>${summary.repricingActionable || 0}</strong>
      </div>
      <div class="listing-summary-card">
        <span class="listing-summary-label">In comp range</span>
        <strong>${summary.repricingCounts?.aligned || 0}</strong>
      </div>
    `;
  }

  if (!listings.length) {
    listingsResults.innerHTML = `<div class="empty-state">No active listings found for this filter.</div>`;
    listingsStatus.textContent = data?.analyticsError
      ? `No active listings found · sales analytics unavailable: ${data.analyticsError}`
      : "No active listings found.";
    return;
  }

  listingsResults.innerHTML = listings.map((listing) => `
    <div class="listing-card">
      <div class="listing-card-header">
        <div class="listing-card-media${listing.imageUrl ? "" : " listing-card-media-empty"}">
          ${listing.imageUrl
            ? `<img class="listing-card-thumb" src="${salesEscape(listing.imageUrl)}" alt="${salesEscape(listing.title || "Listing thumbnail")}" loading="lazy" referrerpolicy="no-referrer" />`
            : `<span class="listing-card-thumb-fallback">No image</span>`}
        </div>
        <div>
          <div class="listing-card-title">${salesEscape(listing.title || "Untitled listing")}</div>
          <div class="listing-card-subtitle">
            ${salesEscape(listing.sport || "Unmatched")}
            ${listing.format ? ` · ${salesEscape(listing.format)}` : ""}
            ${listing.status ? ` · ${salesEscape(listing.status)}` : ""}
            ${listing.sku ? ` · SKU ${salesEscape(listing.sku)}` : ""}
          </div>
        </div>
        <div class="listing-price-block">
          <strong>${formatSalesMoney(listing.currentPrice || 0)}</strong>
          <span class="muted">${Number.isFinite(listing.quantity) ? `${listing.quantity} avail` : "Qty n/a"}</span>
        </div>
      </div>
      <div class="listing-pills">
        <span class="listing-pill">${listing.listedAt ? `Started ${salesEscape(salesDateLabel(listing.listedAt))}` : "Start date unknown"}</span>
        <span class="listing-pill">${salesEscape(formatListingDays(listing.daysListed))}</span>
        <span class="listing-pill">${listing.bestOfferEnabled ? "Best offer on" : "Best offer off"}</span>
        ${listing.listingId ? `<span class="listing-pill">Item ${salesEscape(listing.listingId)}</span>` : ""}
        <span class="listing-pill">${salesEscape(listingRepricingPill(listing.repricing))}</span>
      </div>
      <div class="listing-analytics-grid">
        <div class="listing-analytics-tile">
          <span class="listing-analytics-label">Sold ${data?.analyticsWindowDays || 90}d</span>
          <strong>${listing.analytics?.soldUnits || 0}</strong>
        </div>
        <div class="listing-analytics-tile">
          <span class="listing-analytics-label">Revenue ${data?.analyticsWindowDays || 90}d</span>
          <strong>${formatSalesMoney(listing.analytics?.totalRevenue || 0)}</strong>
        </div>
        <div class="listing-analytics-tile">
          <span class="listing-analytics-label">Last sale</span>
          <strong>${listing.analytics?.lastSaleAt ? salesEscape(salesDateLabel(listing.analytics.lastSaleAt)) : "None"}</strong>
        </div>
        <div class="listing-analytics-tile">
          <span class="listing-analytics-label">eBay metrics</span>
          <strong>${[
            Number.isFinite(listing.analytics?.watchCount) ? `${listing.analytics.watchCount} watchers` : null,
            Number.isFinite(listing.analytics?.impressionCount) ? `${listing.analytics.impressionCount} impressions` : null,
            Number.isFinite(listing.analytics?.soldQuantity) ? `${listing.analytics.soldQuantity} lifetime sold` : null,
          ].filter(Boolean).join(" · ") || "No extra metrics"}</strong>
        </div>
        <div class="listing-analytics-tile">
          <span class="listing-analytics-label">${listingRepricingSourceLabel(listing.repricing?.source)} target</span>
          <strong>${Number.isFinite(listing.repricing?.targetPrice) ? formatSalesMoney(listing.repricing.targetPrice) : "No target"}</strong>
        </div>
        <div class="listing-analytics-tile">
          <span class="listing-analytics-label">Comp range</span>
          <strong>${salesEscape(listingRepricingRangeLabel(listing.repricing))}</strong>
        </div>
        <div class="listing-analytics-tile">
          <span class="listing-analytics-label">Variance</span>
          <strong>${salesEscape(listingRepricingDeltaLabel(listing.repricing))}</strong>
        </div>
      </div>
      <div class="sales-card-meta">
        ${listing.cardId ? `<button class="btn btn-sm btn-outline" data-action="review-sales-card" data-id="${salesEscape(listing.cardId)}">Open card</button>` : ""}
        <button class="btn btn-sm btn-outline" data-action="manual-comp-reprice" data-listing-id="${salesEscape(listing.listingId || "")}" data-sku="${salesEscape(listing.sku || "")}" data-offer-id="${salesEscape(listing.offerId || "")}" data-card-id="${salesEscape(listing.cardId || "")}" data-price="${salesEscape(String(listing.currentPrice ?? ""))}" data-title="${salesEscape(listing.title || "")}">${Number.isFinite(listing.repricing?.targetPrice) ? "Refresh comps" : "Check comps"}</button>
        <button class="btn btn-sm btn-outline" data-action="edit-listing-price" data-listing-id="${salesEscape(listing.listingId || "")}" data-sku="${salesEscape(listing.sku || "")}" data-offer-id="${salesEscape(listing.offerId || "")}" data-format="${salesEscape(listing.format || "")}" data-price="${salesEscape(String(listing.currentPrice ?? ""))}">Edit price</button>
        ${listing.listingUrl ? `<a class="sales-dashboard-link" href="${salesEscape(listing.listingUrl)}" target="_blank" rel="noopener">View item</a>` : ""}
      </div>
    </div>
  `).join("");

  listingsStatus.textContent = `Loaded ${summary.totalListings || 0} active listings · ${listingAgeFilterLabel(data?.ageFilter)} · ${summary.accountSalesOrdersInWindow || 0} orders in ${data?.analyticsWindowDays || 90}d · ${formatSalesMoney(summary.accountSoldRevenueInWindow || 0)} account revenue`;
  if (data?.analyticsError) {
    listingsStatus.textContent += ` · sales analytics unavailable: ${data.analyticsError}`;
  }
  const queue = data?.externalRepriceQueue || null;
  if (queue && ((queue.offerQueueLength || 0) > 0 || queue.offerQueueActive || (queue.scheduledThisLoad || 0) > 0)) {
    listingsStatus.textContent += ` · Sold-comp sync ${queue.offerQueueActive ? "running" : "queued"} (${queue.offerQueueLength || 0} waiting, ${queue.scheduledThisLoad || 0}/${queue.perLoadLimit || 0} scheduled this load)`;
  }
}

async function loadListingsDashboard() {
  if (!listingsResults) return;
  listingsStatus.textContent = "Loading active listings...";
  if (listingsSummary) listingsSummary.innerHTML = "";
  listingsResults.innerHTML = "<div class=\"empty-state\">Loading active listings...</div>";
  const params = new URLSearchParams();
  params.set("salesDays", listingSalesDays?.value || "90");
  if (listingAgeFilter?.value) params.set("ageFilter", listingAgeFilter.value);
  if (listingSport?.value) params.set("sport", listingSport.value);
  if (listingSearch?.value) params.set("search", listingSearch.value);
  if (listingSort?.value) params.set("sort", listingSort.value);
  params.set("pageSize", "100");
  params.set("maxPages", "10");
  params.set("_ts", String(Date.now()));
  try {
    const data = await api(`/api/ebay/listings?${params.toString()}`, { cache: "no-store" });
    renderListingsDashboard(data);
  } catch (error) {
    if (listingsSummary) listingsSummary.innerHTML = "";
    listingsStatus.textContent = error.message;
    listingsResults.innerHTML = `<div class="empty-state">${error.message}</div>`;
  }
}

function formatSalesMoney(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `$${Number(value).toFixed(2)}`;
}

function salesDateLabel(dateValue) {
  if (!dateValue) return "Unknown date";
  const d = new Date(dateValue);
  return Number.isNaN(d.getTime())
    ? "Unknown date"
    : d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
}

function salesEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sortedSalesSports(sports = []) {
  const sortMode = salesSportSort?.value || "amount";
  return [...sports].sort((a, b) => {
    if (sortMode === "sportAsc") return String(a.sport || "").localeCompare(String(b.sport || ""));
    if (sortMode === "sportDesc") return String(b.sport || "").localeCompare(String(a.sport || ""));
    if (sortMode === "quantity") return (b.quantity || 0) - (a.quantity || 0);
    return (b.totalAmount || 0) - (a.totalAmount || 0);
  });
}

function salesLineLinks(line = {}) {
  const links = [];
  if (line.sellerOrderUrl) {
    links.push(`<a class="sales-dashboard-link" href="${salesEscape(line.sellerOrderUrl)}" target="_blank" rel="noopener">Order detail</a>`);
  }
  if (line.itemUrl) {
    links.push(`<a class="sales-dashboard-link" href="${salesEscape(line.itemUrl)}" target="_blank" rel="noopener">Original listing</a>`);
  }
  return links.length ? `<span class="sales-line-actions">${links.join("")}</span>` : "";
}

function salesFilterSummary(data = {}) {
  const dateRange = data?.dateRange || {};
  const from = dateRange.startDate || salesStartDate?.value || "";
  const to = dateRange.endDate || salesEndDate?.value || "";
  const sport = salesSport?.value || "";
  let dateLabel = "";
  if (from && to) {
    dateLabel = `${from} to ${to}`;
  } else if (from) {
    dateLabel = `Since ${from}`;
  } else if (to) {
    dateLabel = `Through ${to}`;
  } else {
    dateLabel = `Last ${salesDays?.value || "90"} days`;
  }
  return {
    dateLabel,
    sportLabel: sport ? sport.charAt(0).toUpperCase() + sport.slice(1) : "All sports",
  };
}

function renderSalesSummary(summary = {}, data = {}) {
  if (!salesSummary) return;
  const filters = salesFilterSummary(data);
  salesSummary.innerHTML = `
    <div class="listing-summary-card sales-summary-filters">
      <span class="listing-summary-label">Active filters</span>
      <strong>${salesEscape(filters.dateLabel)}</strong>
      <span class="muted">${salesEscape(filters.sportLabel)}</span>
    </div>
    <div class="listing-summary-card">
      <span class="listing-summary-label">All account orders</span>
      <strong>${summary.totalOrders || 0}</strong>
    </div>
    <div class="listing-summary-card">
      <span class="listing-summary-label">All account units sold</span>
      <strong>${summary.totalUnits || 0}</strong>
    </div>
    <div class="listing-summary-card">
      <span class="listing-summary-label">All account revenue</span>
      <strong>${formatSalesMoney(summary.totalAmount || 0)}</strong>
    </div>
    <div class="listing-summary-card">
      <span class="listing-summary-label">Matched app-card sales</span>
      <strong>${summary.matchedUnits || 0} · ${formatSalesMoney(summary.matchedAmount || 0)}</strong>
    </div>
    <div class="listing-summary-card">
      <span class="listing-summary-label">Unmatched account sales</span>
      <strong>${summary.unmatchedUnits || 0} · ${formatSalesMoney(summary.unmatchedAmount || 0)}</strong>
    </div>
    <div class="listing-summary-card">
      <span class="listing-summary-label">App cards marked sold</span>
      <strong>${summary.syncedCards || 0}</strong>
    </div>
    <div class="listing-summary-card">
      <span class="listing-summary-label">App offers marked sold</span>
      <strong>${summary.syncedOffers || 0}</strong>
    </div>
  `;
}

function renderSalesSportChart(data = {}) {
  if (!salesSportChart) return;
  const breakdown = Array.isArray(data?.sportBreakdown) ? data.sportBreakdown : [];
  if (!breakdown.length) {
    salesSportChart.innerHTML = "";
    return;
  }
  const totalRevenue = breakdown.reduce((sum, entry) => sum + (Number(entry.totalAmount) || 0), 0);
  const palette = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed", "#0891b2", "#6b7280"];
  let progress = 0;
  const segments = breakdown.map((entry, index) => {
    const value = Number(entry.totalAmount) || 0;
    const share = totalRevenue > 0 ? value / totalRevenue : 0;
    const start = progress * 360;
    progress += share;
    const end = progress * 360;
    return {
      ...entry,
      color: palette[index % palette.length],
      percent: share * 100,
      start,
      end,
    };
  });
  const pieStops = segments
    .map((entry) => `${entry.color} ${entry.start}deg ${entry.end}deg`)
    .join(", ");
  salesSportChart.innerHTML = `
    <section class="sales-breakdown-card">
      <div class="sales-breakdown-header">
        <div>
          <div class="listing-summary-label">Sales by sport</div>
          <strong>${formatSalesMoney(totalRevenue)} total revenue</strong>
        </div>
        <span class="muted">${segments.reduce((sum, entry) => sum + (entry.quantity || 0), 0)} units sold</span>
      </div>
      <div class="sales-breakdown-body">
        <div class="sales-pie-wrap">
          <div class="sales-pie-chart" style="--sales-pie:${pieStops || "#d1d5db 0deg 360deg"}"></div>
        </div>
        <div class="sales-pie-legend">
          ${segments.map((entry) => `
            <div class="sales-pie-row">
              <span class="sales-pie-swatch" style="background:${entry.color}"></span>
              <div class="sales-pie-copy">
                <strong>${salesEscape(entry.sport || "Unmatched")}</strong>
                <span class="muted">${entry.quantity || 0} units · ${formatSalesMoney(entry.totalAmount || 0)} · ${entry.percent.toFixed(1)}%</span>
              </div>
            </div>
          `).join("")}
        </div>
      </div>
    </section>
  `;
}

function renderSalesReport(data) {
  if (!salesResults) return;
  const summary = data?.summary || {};
  const groups = Array.isArray(data?.groups) ? data.groups : [];
  const filters = salesFilterSummary(data);
  renderSalesSummary(summary, data);
  renderSalesSportChart(data);
  if (!groups.length) {
    salesResults.innerHTML = `<div class="empty-state">No sales found for this range.</div>`;
    salesStatus.textContent = `No sales found · ${summary.totalOrders || 0} orders`;
    if (summary.syncedCards || summary.syncedOffers) {
      salesStatus.textContent += ` · synced ${summary.syncedCards || 0} cards / ${summary.syncedOffers || 0} offers`;
    }
    return;
  }
  salesResults.innerHTML = groups.map((monthGroup) => `
    <details class="sales-folder">
      <summary class="sales-folder-header">
        <span class="sales-folder-title">
          ${salesEscape(monthGroup.monthLabel || "Unknown month")}
          <span class="sales-folder-count">${monthGroup.quantity || 0} sold · ${formatSalesMoney(monthGroup.totalAmount || 0)}</span>
        </span>
        <span class="sales-folder-chevron"></span>
      </summary>
      <div class="sales-folder-body">
        ${sortedSalesSports(monthGroup.sports).map((sportGroup) => `
          <div class="sales-sport-group">
            <h3>${salesEscape(sportGroup.sport || "Unmatched")} <span class="muted">(${sportGroup.quantity || 0} · ${formatSalesMoney(sportGroup.totalAmount || 0)})</span></h3>
            ${sportGroup.cards.map((card) => `
              ${(() => {
                const recentLine = [...(Array.isArray(card.lines) ? card.lines : [])]
                  .sort((a, b) => String(b.soldAt || "").localeCompare(String(a.soldAt || "")))[0] || null;
                const headerLinks = [];
                if (recentLine?.sellerOrderUrl) {
                  headerLinks.push(`<a class="sales-dashboard-link" href="${salesEscape(recentLine.sellerOrderUrl)}" target="_blank" rel="noopener">Latest order</a>`);
                }
                if (recentLine?.itemUrl) {
                  headerLinks.push(`<a class="sales-dashboard-link" href="${salesEscape(recentLine.itemUrl)}" target="_blank" rel="noopener">Latest listing</a>`);
                }
                return `
              <div class="sales-card">
                <div class="sales-card-header">
                  <div class="sales-card-thumb${card.imageUrl ? "" : " sales-card-thumb-empty"}">
                    ${card.imageUrl
                      ? `<img src="${salesEscape(card.imageUrl)}" alt="${salesEscape(card.cardLabel || "Sold card")}" loading="lazy" referrerpolicy="no-referrer" />`
                      : `<span>No image</span>`}
                  </div>
                  <div class="sales-card-title">
                    <div>${salesEscape(card.cardLabel || "Unmatched sale item")}${card.sku ? `<span class="muted"> · ${salesEscape(card.sku)}</span>` : ""}</div>
                    <div class="muted">${card.quantity || 0} x ${formatSalesMoney(card.totalAmount || 0)}</div>
                  </div>
                </div>
                <div class="sales-card-meta">
                  <div class="sales-card-meta-actions">
                    ${card.cardId ? `<button class="btn btn-sm btn-outline" data-action="review-sales-card" data-id="${salesEscape(card.cardId)}">Open card</button>` : ""}
                    ${headerLinks.join("")}
                  </div>
                  <span class="muted">Sport: ${salesEscape(card.sport || "Unmatched")}</span>
                </div>
                <div class="sales-card-lines">
                  ${card.lines.map((line) => `
                    <div class="sales-line">
                      <span>${salesEscape(salesDateLabel(line.soldAt))} · ${line.soldQty}x ${salesEscape(line.lineTitle || "Sale item")} · ${formatSalesMoney(line.totalPrice || 0)}${line.orderId ? ` · order ${salesEscape(line.orderId)}` : ""}</span>
                      ${salesLineLinks(line)}
                    </div>
                  `).join("")}
                </div>
              </div>
            `;
              })()}
            `).join("")}
          </div>
        `).join("")}
      </div>
    </details>
  `).join("");
  salesStatus.textContent = `Loaded ${summary.totalOrders || 0} orders · ${summary.totalUnits || 0} units · ${formatSalesMoney(summary.totalAmount || 0)} · ${filters.dateLabel}`;
  const filterText = salesSport?.value ? ` · ${filters.sportLabel}` : "";
  salesStatus.textContent += filterText;
  if (salesSportSort?.value) salesStatus.textContent += ` · sorted by ${salesSportSort.options[salesSportSort.selectedIndex]?.text || "sport"}`;
  if (summary.syncedCards || summary.syncedOffers) {
    salesStatus.textContent += ` · synced ${summary.syncedCards || 0} cards / ${summary.syncedOffers || 0} offers`;
  }
}

function toSalesInputDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function applySalesRangePreset() {
  if (!salesRangePreset) return;
  const preset = salesRangePreset.value || "90";
  if (preset === "custom") return;
  const days = Math.max(1, Number(preset) || 90);
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (days - 1));
  if (salesDays) salesDays.value = String(days);
  if (salesStartDate) salesStartDate.value = toSalesInputDate(start);
  if (salesEndDate) salesEndDate.value = toSalesInputDate(end);
}

async function loadSalesReport() {
  if (!salesResults) return;
  salesStatus.textContent = "Loading sales from eBay...";
  if (salesSummary) salesSummary.innerHTML = "";
  if (salesSportChart) salesSportChart.innerHTML = "";
  salesResults.innerHTML = "<div class=\"empty-state\">Loading sales...</div>";
  const params = new URLSearchParams();
  const startDate = salesStartDate?.value || "";
  const endDate = salesEndDate?.value || "";
  const days = salesDays?.value || "";
  const sport = salesSport?.value || "";
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  if (!startDate && !endDate) params.set("days", days || "90");
  if (sport) params.set("sport", sport);
  params.set("pageSize", "100");
  params.set("maxPages", "5");
  params.set("sync", "1");
  params.set("_ts", String(Date.now()));
  try {
    const data = await api(`/api/ebay/sales?${params.toString()}`, { cache: "no-store" });
    if ((data?.summary?.syncedCards || 0) > 0 || (data?.summary?.syncedOffers || 0) > 0) {
      await refresh();
    }
    renderSalesReport(data);
  } catch (error) {
    if (salesSummary) salesSummary.innerHTML = "";
    if (salesSportChart) salesSportChart.innerHTML = "";
    salesStatus.textContent = error.message;
    salesResults.innerHTML = `<div class="empty-state">${error.message}</div>`;
  }
}

function marketHeatUpdatedLabel(dateValue) {
  if (!dateValue) return "Unknown";
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function marketHeatLastSoldLabel(player) {
  if (player?.lastSoldAt) {
    return salesEscape(salesDateLabel(player.lastSoldAt));
  }
  return "Unknown";
}

function marketHeatPlayerKey(sportName, playerName) {
  return `${String(sportName || "unknown").trim().toLowerCase()}::${String(playerName || "unknown").trim().toLowerCase()}`;
}

function getMarketHeatPlayerInsight(playerKey) {
  if (!playerKey) return {};
  if (!marketHeatState.playerInsights[playerKey]) {
    marketHeatState.playerInsights[playerKey] = {
      comps: null,
      loadingMode: "",
      status: "",
    };
  }
  return marketHeatState.playerInsights[playerKey];
}

function marketHeatSelectionMetadata(selection) {
  return {
    playerName: String(selection?.player?.player || "").trim(),
    sport: String(selection?.sportGroup?.sport || "").trim(),
  };
}

function marketHeatInsightSummaryHtml(label, result) {
  if (!result) return "";
  const match = result.cardMatch || null;
  const pricing = result.pricingSummary || null;
  const details = [
    result.source ? `Source: ${formatCompSourceLabel(result.source)}` : null,
    result.loadedCount != null ? `Loaded: ${result.loadedCount}` : null,
    result.rejectedCount != null ? `Rejected: ${result.rejectedCount}` : null,
    match?.description ? `Match: ${match.description}` : null,
    match?.matchedVia ? `Via: ${match.matchedVia}` : null,
    pricing?.compPrice != null ? `Comp: ${formatSalesMoney(pricing.compPrice)}` : null,
    pricing?.low != null ? `Low: ${formatSalesMoney(pricing.low)}` : null,
    pricing?.high != null ? `High: ${formatSalesMoney(pricing.high)}` : null,
  ].filter(Boolean);
  if (!details.length) return "";
  return `<div class="market-heat-note muted"><strong>${salesEscape(label)}:</strong> ${salesEscape(details.join(" · "))}</div>`;
}

function marketHeatInsightWarningsHtml(result) {
  if (!result?.cardMatchWarning) return "";
  return `<div class="market-heat-note muted">${salesEscape(result.cardMatchWarning)}</div>`;
}

function marketHeatInsightSectionsHtml(selection) {
  const insight = getMarketHeatPlayerInsight(selection?.playerKey);
  const compsHtml = insight.comps
    ? `
      ${marketHeatInsightSummaryHtml("Player comps", insight.comps)}
      ${marketHeatInsightWarningsHtml(insight.comps)}
      ${renderCompList(
        "Player comps",
        Array.isArray(insight.comps.comps) ? insight.comps.comps : [],
        "No comps loaded.",
        null,
        null,
        20,
      )}
    `
    : "";
  return `
    <div class="form-actions">
      <button
        class="btn btn-sm btn-outline"
        data-market-heat-detail-action="comps"
        ${insight.loadingMode ? "disabled" : ""}
      >${insight.loadingMode === "comps" ? "Loading comps..." : "Load comps"}</button>
    </div>
    ${insight.status ? `<div class="market-heat-note muted">${salesEscape(insight.status)}</div>` : ""}
    ${compsHtml}
  `;
}

function marketHeatCsvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, "\"\"")}"`;
}

function exportMarketHeatReport() {
  const report = marketHeatState.report;
  const sports = Array.isArray(report?.sports) ? report.sports : [];
  if (!sports.length) {
    marketHeatStatus.textContent = "Load market heat before exporting CSV.";
    return;
  }
  const rows = [
    [
      "generated_at",
      "source",
      "window_days",
      "sample_size_per_sport",
      "sport",
      "query",
      "player",
      "rank",
      "units_sold",
      "total_revenue",
      "average_price",
      "matched_listings",
      "last_sold",
      "sample_titles",
    ],
  ];
  for (const sportGroup of sports) {
    for (const player of Array.isArray(sportGroup?.players) ? sportGroup.players : []) {
      rows.push([
        report?.generatedAt || "",
        report?.source || "",
        report?.windowDays || "",
        report?.sampleSizePerSport || "",
        sportGroup?.sport || "",
        sportGroup?.query || "",
        player?.player || "",
        player?.rank || "",
        player?.unitsSold || 0,
        player?.totalRevenue || 0,
        player?.averagePrice || 0,
        player?.listingsMatched || 0,
        marketHeatLastSoldLabel(player, report),
        Array.isArray(player?.sampleTitles) ? player.sampleTitles.join(" | ") : "",
      ]);
    }
  }
  const csv = `${rows.map((row) => row.map(marketHeatCsvEscape).join(",")).join("\n")}\n`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const sportLabel = String(marketHeatSport?.value || "all").trim().toLowerCase() || "all";
  link.href = url;
  link.download = `market-heat-${sportLabel}-${report?.windowDays || 7}d.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  marketHeatStatus.textContent = `Exported ${Math.max(rows.length - 1, 0)} market heat rows to CSV.`;
}

async function loadMarketHeatPlayerInsight(mode) {
  const report = marketHeatState.report;
  const selection = getMarketHeatSelection(report);
  if (!selection) {
    setMarketHeatDetailMessage("Player detail", "Select a player before loading comps.");
    return;
  }
  const insight = getMarketHeatPlayerInsight(selection.playerKey);
  const metadata = marketHeatSelectionMetadata(selection);
  insight.loadingMode = mode;
  insight.status = "Loading comps...";
  renderMarketHeatDetail(report);

  try {
    const params = new URLSearchParams();
    params.set("player", metadata.playerName);
    params.set("sport", metadata.sport);
    params.set("count", "20");
    const result = await api(`/api/ebay/market-heat/player-insight?${params.toString()}`, {
      cache: "no-store",
    });
    insight[mode] = result;
    insight.status = `Loaded ${result.loadedCount || 0} comps for ${metadata.playerName}.`;
  } catch (error) {
    insight.status = error.message;
  } finally {
    insight.loadingMode = "";
    renderMarketHeatDetail(report);
  }
}

function setMarketHeatDetailMessage(title, message) {
  if (!marketHeatDetail) return;
  marketHeatDetail.innerHTML = `
    <article class="sales-card">
      <div class="sales-card-title">${salesEscape(title)}</div>
      <p class="muted">${salesEscape(message)}</p>
    </article>
  `;
}

function getMarketHeatSelection(data) {
  const sports = Array.isArray(data?.sports) ? data.sports : [];
  const selectedKey = marketHeatState.selectedPlayerKey;
  let fallback = null;

  for (const sportGroup of sports) {
    const players = Array.isArray(sportGroup?.players) ? sportGroup.players : [];
    for (const player of players) {
      const playerKey = marketHeatPlayerKey(sportGroup?.sport, player?.player);
      const selection = { sportGroup, player, playerKey };
      if (!fallback) fallback = selection;
      if (playerKey === selectedKey) return selection;
    }
  }

  return fallback;
}

function renderMarketHeatDetail(data) {
  if (!marketHeatDetail) return;
  const selection = getMarketHeatSelection(data);
  if (!selection) {
    setMarketHeatDetailMessage(
      "Player detail",
      "Select a player from the market heat board to inspect recent sales activity and sample titles.",
    );
    return;
  }

  marketHeatState.selectedPlayerKey = selection.playerKey;
  const { sportGroup, player } = selection;
  const sampleTitles = Array.isArray(player?.sampleTitles) ? player.sampleTitles : [];

  marketHeatDetail.innerHTML = `
    <article class="sales-card">
      <div class="market-heat-header">
        <div>
          <div class="market-heat-rank">#${player?.rank || "-"}</div>
          <div class="sales-card-title">${salesEscape(player?.player || "Unknown player")}</div>
          <div class="muted">${salesEscape(sportGroup?.sport || "Unknown sport")} · ${salesEscape("Apify")}</div>
        </div>
        <div class="listing-price-block">
          <strong>${player?.unitsSold || 0} sold</strong>
          <span class="muted">${formatSalesMoney(player?.totalRevenue || 0)}</span>
        </div>
      </div>
      <div class="listing-analytics-grid">
        <div class="listing-analytics-tile">
          <span class="listing-analytics-label">Avg sale</span>
          <strong>${formatSalesMoney(player?.averagePrice || 0)}</strong>
        </div>
        <div class="listing-analytics-tile">
          <span class="listing-analytics-label">Matched listings</span>
          <strong>${player?.listingsMatched || 0}</strong>
        </div>
        <div class="listing-analytics-tile">
          <span class="listing-analytics-label">Last sold</span>
          <strong>${marketHeatLastSoldLabel(player, data)}</strong>
        </div>
        <div class="listing-analytics-tile">
          <span class="listing-analytics-label">Window</span>
          <strong>${data?.windowDays || 7} day${Number(data?.windowDays || 7) === 1 ? "" : "s"}</strong>
        </div>
      </div>
      <div class="market-heat-note muted">Query: ${salesEscape(sportGroup?.query || "")} · Samples: ${sportGroup?.sampleCount || 0} sold listings · Unmatched titles: ${sportGroup?.unmatchedListings || 0}</div>
      ${sampleTitles.length
        ? `<div class="market-heat-samples">${sampleTitles
            .map((title) => `<span class="listing-pill">${salesEscape(title)}</span>`)
            .join("")}</div>`
        : `<div class="muted">No sample titles were included for this player.</div>`}
      ${marketHeatInsightSectionsHtml(selection)}
    </article>
  `;
}

function renderMarketHeatReport(data) {
  if (!marketHeatResults) return;
  marketHeatState.report = data || null;
  const sports = Array.isArray(data?.sports) ? data.sports : [];

  if (marketHeatSummary) {
    marketHeatSummary.innerHTML = `
      <div class="listing-summary-card">
        <span class="listing-summary-label">Updated</span>
        <strong>${salesEscape(marketHeatUpdatedLabel(data?.generatedAt))}</strong>
      </div>
      <div class="listing-summary-card">
        <span class="listing-summary-label">Source</span>
        <strong>${salesEscape("Apify")}</strong>
      </div>
      <div class="listing-summary-card">
        <span class="listing-summary-label">Window</span>
        <strong>${data?.windowDays || 7} day${Number(data?.windowDays || 7) === 1 ? "" : "s"}</strong>
      </div>
      <div class="listing-summary-card">
        <span class="listing-summary-label">Sample / sport</span>
        <strong>${data?.sampleSizePerSport || 0}</strong>
      </div>
      <div class="listing-summary-card">
        <span class="listing-summary-label">Snapshot</span>
        <strong>${salesEscape(data?.cacheStatus === "refreshed" ? "Refreshed now" : "Weekly cache")}</strong>
      </div>
    `;
  }

  if (!sports.length) {
    marketHeatResults.innerHTML = `<div class="empty-state">No market heat data found for this sport.</div>`;
    marketHeatStatus.textContent = "No market heat data found.";
    marketHeatState.selectedPlayerKey = "";
    renderMarketHeatDetail(null);
    return;
  }

  const selection = getMarketHeatSelection(data);
  marketHeatState.selectedPlayerKey = selection?.playerKey || "";

  marketHeatResults.innerHTML = sports.map((sportGroup) => `
    <details class="sales-folder" open>
      <summary class="sales-folder-header">
        <span class="sales-folder-title">
          ${salesEscape(sportGroup.sport || "Unknown sport")}
          <span class="sales-folder-count">${sportGroup.players?.length || 0} players · ${sportGroup.matchedListings || 0} matched sales</span>
        </span>
        <span class="sales-folder-chevron"></span>
      </summary>
      <div class="sales-folder-body">
        <div class="market-heat-note muted">Query: ${salesEscape(sportGroup.query || "")} · Samples: ${sportGroup.sampleCount || 0} sold listings · Unmatched titles: ${sportGroup.unmatchedListings || 0}</div>
        ${(sportGroup.players || []).map((player) => `
          <div
            class="sales-card market-heat-card${marketHeatPlayerKey(sportGroup.sport, player.player) === marketHeatState.selectedPlayerKey ? " market-heat-card-selected" : ""}"
            data-market-heat-player="${encodeURIComponent(marketHeatPlayerKey(sportGroup.sport, player.player))}"
            role="button"
            tabindex="0"
            aria-pressed="${marketHeatPlayerKey(sportGroup.sport, player.player) === marketHeatState.selectedPlayerKey ? "true" : "false"}"
          >
            <div class="market-heat-header">
              <div>
                <div class="market-heat-rank">#${player.rank}</div>
                <div class="sales-card-title">${salesEscape(player.player || "Unknown player")}</div>
              </div>
              <div class="listing-price-block">
                <strong>${player.unitsSold || 0} sold</strong>
                <span class="muted">${formatSalesMoney(player.totalRevenue || 0)}</span>
              </div>
            </div>
            <div class="listing-analytics-grid">
              <div class="listing-analytics-tile">
                <span class="listing-analytics-label">Avg sale</span>
                <strong>${formatSalesMoney(player.averagePrice || 0)}</strong>
              </div>
              <div class="listing-analytics-tile">
                <span class="listing-analytics-label">Matched listings</span>
                <strong>${player.listingsMatched || 0}</strong>
              </div>
              <div class="listing-analytics-tile">
                <span class="listing-analytics-label">Last sold</span>
                <strong>${marketHeatLastSoldLabel(player, data)}</strong>
              </div>
            </div>
            ${(player.sampleTitles || []).length
              ? `<div class="market-heat-samples">${player.sampleTitles
                  .map((title) => `<span class="listing-pill">${salesEscape(title)}</span>`)
                  .join("")}</div>`
              : "" }
          </div>
        `).join("")}
      </div>
    </details>
  `).join("");

  renderMarketHeatDetail(data);

  marketHeatStatus.textContent = `Loaded ${sports.length} sport${sports.length === 1 ? "" : "s"} · ${data?.windowDays || 7}-day window · ${data?.sampleSizePerSport || 500} rows per sport · Top ${Math.min(data?.limitPlayers || 50, 50)} players · ${"Apify"} ${data?.cacheStatus === "refreshed" ? "refreshed" : "cached"}`;
}

async function loadMarketHeatReport({ forceRefresh = false } = {}) {
  if (!marketHeatResults) return;
  marketHeatState.playerInsights = Object.create(null);
  marketHeatStatus.textContent = forceRefresh
    ? "Refreshing market heat snapshot..."
    : "Loading market heat...";
  if (marketHeatSummary) marketHeatSummary.innerHTML = "";
  setMarketHeatDetailMessage("Player detail", "Loading market heat snapshot...");
  marketHeatResults.innerHTML = "<div class=\"empty-state\">Loading market heat...</div>";
  const params = new URLSearchParams();
  params.set("days", marketHeatDays?.value || "7");
  params.set("sport", marketHeatSport?.value || "all");
  params.set("limitPlayers", "50");
  params.set("sampleSize", "500");
  if (forceRefresh) params.set("refresh", "1");
  params.set("_ts", String(Date.now()));
  try {
    const data = await api(`/api/ebay/market-heat?${params.toString()}`, { cache: "no-store" });
    renderMarketHeatReport(data);
  } catch (error) {
    if (marketHeatSummary) marketHeatSummary.innerHTML = "";
    marketHeatStatus.textContent = error.message;
    marketHeatResults.innerHTML = `<div class="empty-state">${error.message}</div>`;
    setMarketHeatDetailMessage("Player detail", error.message);
  }
}

function renderCards() {
  const filterBatch = batchFilter.value;
  let filtered = state.cardItems.filter((c) => c.status !== "sent_to_grading");
  if (filterBatch) filtered = filtered.filter((c) => c.batchId === filterBatch);
  if (!filtered.length) {
    cardsList.innerHTML = `<div class="empty-state">No cards ${filterBatch ? `in batch ${filterBatch}` : "uploaded yet"}</div>`;
    return;
  }
  filtered.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  const batchLookup = {};
  for (const b of state.batches) batchLookup[b.id] = b;
  const offerLookup = {};
  for (const o of (state.offers || [])) offerLookup[o.cardItemId] = o;

  cardsList.innerHTML = filtered.map((card) => {
    const batch = batchLookup[card.batchId];
    const offer = offerLookup[card.id];
    const canCreateOffer = !offer || ["failed", "deleted"].includes(offer.status);
    // The only other way to publish an offer was the batch-level "Publish"
    // button, which publishes every unpublished offer in the whole batch at
    // once — there was no way to publish just one card's already-created
    // offer on its own.
    const canPublishOffer = Boolean(offer && offer.ebayOfferId && !offer.listingUrl && !canCreateOffer);
    // normalizeState() in src/lib/store.js forces status/publishState back
    // to listed/published for any card with a real listingUrl, so "Send to
    // Grading" would be a confusing no-op once a card is actually live.
    const isPublished = card.status === "listed" || card.publishState === "published" || Boolean(card.listingUrl);
    const title = [card.candidateYear, card.candidatePlayer, card.candidateSetName, card.candidateCardNumber].filter(Boolean).join(" · ") || card.id;
    return `<div class="card-item" data-card-id="${card.id}">
      <div class="card-item-header">
        <div class="card-item-title">${title}</div>
        <div class="card-item-id">${card.id}</div>
      </div>
      <div class="card-item-details">
        <span class="card-item-detail"><strong>Price:</strong> ${card.recommendedPrice == null ? "n/a" : money(card.recommendedPrice)}</span>
        <span class="card-item-detail"><strong>Conf:</strong> ${Math.round((card.confidenceScore || 0) * 100)}%</span>
        <span class="card-item-detail"><strong>Batch:</strong> ${batch ? batch.id : card.batchId}</span>
        ${card.candidateParallel ? `<span class="card-item-detail"><strong>Par:</strong> ${card.candidateParallel}</span>` : ""}
        ${card.candidateBaseHint ? `<span class="card-item-detail"><strong>Base</strong></span>` : ""}
        ${card.candidateAutoHint ? `<span class="card-item-detail"><strong>Auto</strong></span>` : ""}
        ${offer ? `<span class="card-item-detail"><strong>Offer:</strong> ${offer.status}</span>` : ""}
      </div>
      <div class="card-item-footer">
        ${statusBadge(card.status)}
        ${disagreementBadge(card)}
        <div class="card-item-actions">
          <button class="btn btn-sm btn-outline" data-action="review-card" data-id="${card.id}">Review</button>
          ${canCreateOffer
            ? `<button class="btn btn-sm btn-outline" data-action="create-card-offer" data-id="${card.id}">Create BIN Offer</button>
               <button class="btn btn-sm btn-outline" data-action="create-card-auction-offer" data-id="${card.id}">Create Auction Offer</button>`
            : `${canPublishOffer ? `<button class="btn btn-sm" data-action="publish-card-offer" data-id="${offer.id}">Publish</button>` : ""}
               <button class="btn btn-sm btn-outline" data-action="delete-offer" data-id="${offer.id}">Del offer</button>`
          }
          <button class="btn btn-sm btn-outline" data-action="approve-card" data-id="${card.id}">Approve</button>
          ${isPublished || !gradingFeatureEnabled ? "" : `<button class="btn btn-sm btn-outline" data-action="send-to-grading-card" data-id="${card.id}">Send to Grading</button>`}
          <button class="btn btn-sm btn-outline btn-danger" data-action="delete-card" data-id="${card.id}">Del</button>
        </div>
      </div>
    </div>`;
  }).join("");
}

function renderBatchFilter() {
  batchFilter.innerHTML = `<option value="">All batches</option>`;
  for (const b of state.batches) {
    batchFilter.innerHTML += `<option value="${b.id}">${b.id} (${b.source})</option>`;
  }
}

async function refresh() {
  const boot = await api("/api/bootstrap");
  state = boot;
  gradingFeatureEnabled = Boolean(boot.gradingFeatureEnabled);
  const gradingNavButton = document.querySelector('.nav-item[data-tab="grading"]');
  const gradingTabContent = document.getElementById("tab-grading");
  if (gradingNavButton) gradingNavButton.style.display = gradingFeatureEnabled ? "" : "none";
  if (gradingTabContent) gradingTabContent.style.display = gradingFeatureEnabled ? "" : "none";
  if (!gradingFeatureEnabled && gradingNavButton?.classList.contains("active")) {
    document.querySelector('.nav-item[data-tab="cards"]')?.click();
  }
  renderBatchSelect();
  // Rebuilding the <select>'s options above naturally resets it to its
  // first option ("All batches") — deliberately NOT re-narrowing it to
  // whatever review card happens to be open/restored here, since
  // reviewState.cardId persists across page reloads (see
  // shouldRestoreReviewOverlay() below) and every refresh() call
  // (periodic polling included) was silently re-pinning the Cards tab to
  // one batch, with no way back to "All batches" short of it changing
  // again next refresh.
  renderBatchFilter();
  renderApifyTargetSelect();
  renderReviewCardSelect();
  renderBatches();
  renderCards();
  renderSentToGradingList();
  renderPublishedCards();
  if (boot.driveFolderId && !driveFolderId.value) driveFolderId.value = boot.driveFolderId;
  if (reviewState.cardId) {
    try { await loadReviewCard(reviewState.cardId); } catch { reviewState.cardId = null; reviewState.details = null; renderReviewSummary(null); }
  } else if (reviewCardSelect.value) {
    try { await loadReviewCard(reviewCardSelect.value); } catch { renderReviewSummary(null); }
  } else {
    renderReviewSummary(null);
  }
  if (shouldRestoreReviewOverlay() && reviewState.cardId) {
    openReviewOverlay();
  }
  serverStatus.textContent = "Connected";
}

/* ── DA Card World watcher ── */
const DACARDWORLD_SPORT_ORDER = [
  "Basketball",
  "Football",
  "Baseball",
  "Hockey",
  "Soccer",
  "Racing",
  "Wrestling",
  "MMA/Boxing",
  "Golf",
  "TCG/Non-Sport",
  "Other",
];

function groupDaCardWorldBySport(items) {
  const groups = new Map();
  for (const item of items) {
    const sport = item.sport || "Other";
    if (!groups.has(sport)) groups.set(sport, []);
    groups.get(sport).push(item);
  }
  return [...groups.entries()].sort((a, b) => {
    const ai = DACARDWORLD_SPORT_ORDER.indexOf(a[0]);
    const bi = DACARDWORLD_SPORT_ORDER.indexOf(b[0]);
    return (ai === -1 ? DACARDWORLD_SPORT_ORDER.length : ai) - (bi === -1 ? DACARDWORLD_SPORT_ORDER.length : bi);
  });
}

function renderDaCardWorldItem(item) {
  const priceParts = [];
  if (item.originalPrice != null) priceParts.push(`<s class="muted">$${item.originalPrice.toFixed(2)}</s>`);
  if (item.price != null) priceParts.push(`$${item.price.toFixed(2)}`);
  return `<article class="sales-card dacardworld-item">
    <div class="dacardworld-item-title">
      <a href="${salesEscape(item.url)}" target="_blank" rel="noopener">${salesEscape(item.title)}</a>
      ${item.isNew ? '<span class="badge">New</span>' : ""}
    </div>
    ${priceParts.length ? `<div class="dacardworld-item-price">${priceParts.join(" ")}</div>` : ""}
  </article>`;
}

function renderDaCardWorldList(container, items) {
  if (!items || !items.length) {
    container.innerHTML = `<div class="empty-state">Nothing here yet — try Refresh now.</div>`;
    return;
  }
  container.innerHTML = groupDaCardWorldBySport(items)
    .map(
      ([sport, group]) =>
        `<h4 class="dacardworld-sport-heading">${salesEscape(sport)}</h4>${group.map(renderDaCardWorldItem).join("")}`,
    )
    .join("");
}

async function loadDaCardWorldSnapshot() {
  try {
    const data = await api("/api/dacardworld");
    renderDaCardWorldList(daCardWorldNewReleases, data.newReleases);
    renderDaCardWorldList(daCardWorldDeals, data.deals);
    daCardWorldUpdatedAt.textContent = data.generatedAt
      ? `Last updated ${new Date(data.generatedAt).toLocaleString()}`
      : "Never refreshed yet — click Refresh now.";
  } catch (e) {
    daCardWorldStatus.textContent = e.message;
  }
}

if (daCardWorldRefreshButton) {
  daCardWorldRefreshButton.addEventListener("click", async () => {
    daCardWorldStatus.textContent = "Refreshing (this can take a minute)...";
    try {
      await api("/api/dacardworld/refresh", { method: "POST" });
      daCardWorldStatus.textContent = "Refresh started — check back shortly.";
      setTimeout(loadDaCardWorldSnapshot, 30000);
    } catch (e) {
      daCardWorldStatus.textContent = e.message;
    }
  });
}

/* ── Tab navigation ── */
document.querySelectorAll(".nav-item[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab-content").forEach((t) => t.classList.remove("active"));
    const tab = document.getElementById(`tab-${btn.dataset.tab}`);
    if (tab) tab.classList.add("active");
    if (btn.dataset.tab === "published") renderPublishedCards();
    if (btn.dataset.tab === "listings") {
      if (listingsLoadButton && !listingsResults?.innerHTML) loadListingsDashboard();
    }
    if (btn.dataset.tab === "sales") {
      const today = new Date();
      const monthStart = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
      if (salesEndDate && !salesEndDate.value) salesEndDate.value = today.toISOString().slice(0, 10);
      if (salesStartDate && !salesStartDate.value) salesStartDate.value = monthStart.toISOString().slice(0, 10);
      if (salesLoadButton && !salesResults?.innerHTML) loadSalesReport();
      if (salesDays) salesDays.value = "30";
    }
    if (btn.dataset.tab === "market-heat") {
      if (marketHeatLoadButton && !marketHeatResults?.innerHTML) loadMarketHeatReport();
    }
    if (btn.dataset.tab === "grading") {
      loadGradingItems();
    }
    if (btn.dataset.tab === "dacardworld" && !daCardWorldNewReleases?.innerHTML) {
      loadDaCardWorldSnapshot();
    }
  });
});

/* ── Batch & upload ── */
newBatchButton.addEventListener("click", () => cardRows.prepend(makeCardRow()));
addCardRowButton.addEventListener("click", () => cardRows.appendChild(makeCardRow()));

createBatchButton.addEventListener("click", async () => {
  try {
    const batch = await api("/api/batches", {
      method: "POST",
      body: JSON.stringify({
        source: document.getElementById("batchSource").value,
        notes: document.getElementById("batchNotes").value,
      }),
    });
    batchMessage.textContent = `Created ${batch.id}`;
    await refresh();
    activeBatchSelect.value = batch.id;
  } catch (e) { batchMessage.textContent = e.message; }
});

uploadCardsButton.addEventListener("click", async () => {
  try {
    const batchId = activeBatchSelect.value;
    if (!batchId) throw new Error("Create or select a batch first.");
    const rows = [...cardRows.querySelectorAll(".card-row")];
    const cards = [];
    for (const row of rows) {
      const frontInput = row.querySelector('input[data-side="front"]');
      const backInput = row.querySelector('input[data-side="back"]');
      if (!frontInput.files[0] || !backInput.files[0]) continue;
      cards.push({
        front: { fileName: frontInput.files[0].name, dataUrl: await readFileAsDataUrl(frontInput.files[0]) },
        back: { fileName: backInput.files[0].name, dataUrl: await readFileAsDataUrl(backInput.files[0]) },
        notes: row.querySelector('input[data-side="notes"]').value,
        printRun: row.querySelector('input[data-side="printRun"]').value,
        parallel: row.querySelector('input[data-side="parallel"]').value,
        baseCardHint: row.querySelector('input[data-side="base"]')?.checked || false,
        autoCardHint: row.querySelector('input[data-side="auto"]')?.checked || false,
        thickCard: row.querySelector('input[data-side="thick"]')?.checked || false,
      });
    }
    if (!cards.length) throw new Error("Add at least one front/back pair.");
    showProgress("Uploading cards...", 0, `0 / ${cards.length}`);
    const result = await api(`/api/batches/${batchId}/cards`, {
      method: "POST",
      body: JSON.stringify({ cards }),
    });
    uploadMessage.textContent = `Uploaded ${result.created.length} cards`;
    cardRows.innerHTML = "";
    cardRows.appendChild(makeCardRow());
    hideProgress();
    await refresh();

    if (result.created.length && confirm(`Process ${result.created.length} cards now?`)) {
      showProgress("Processing OCR...", 0, "Starting...");
      await api(`/api/batches/${batchId}/process`, { method: "POST" });
      hideProgress();
      await refresh();
    }
  } catch (e) { uploadMessage.textContent = e.message; hideProgress(); }
});

refreshButton.addEventListener("click", refresh);

batchFilter.addEventListener("change", () => {
  batchFilter.dataset.selected = batchFilter.value;
  renderCards();
});

if (salesLoadButton) {
  salesLoadButton.addEventListener("click", loadSalesReport);
}
if (salesRangePreset) {
  salesRangePreset.addEventListener("change", applySalesRangePreset);
}
if (salesStartDate) {
  salesStartDate.addEventListener("change", () => {
    if (salesRangePreset) salesRangePreset.value = "custom";
  });
}
if (salesEndDate) {
  salesEndDate.addEventListener("change", () => {
    if (salesRangePreset) salesRangePreset.value = "custom";
  });
}
if (salesSportSort) {
  salesSportSort.addEventListener("change", loadSalesReport);
}
if (marketHeatLoadButton) {
  marketHeatLoadButton.addEventListener("click", () => loadMarketHeatReport());
}
if (marketHeatRefreshButton) {
  marketHeatRefreshButton.addEventListener("click", () =>
    loadMarketHeatReport({ forceRefresh: true }),
  );
}
if (marketHeatExportButton) {
  marketHeatExportButton.addEventListener("click", exportMarketHeatReport);
}
if (marketHeatDays) {
  marketHeatDays.addEventListener("change", () => loadMarketHeatReport());
}
if (marketHeatSport) {
  marketHeatSport.addEventListener("change", () => loadMarketHeatReport());
}
if (marketHeatResults) {
  marketHeatResults.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-market-heat-player]");
    if (!trigger) return;
    marketHeatState.selectedPlayerKey = decodeURIComponent(
      trigger.dataset.marketHeatPlayer || "",
    );
    if (marketHeatState.report) renderMarketHeatReport(marketHeatState.report);
  });
  marketHeatResults.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const trigger = event.target.closest("[data-market-heat-player]");
    if (!trigger) return;
    event.preventDefault();
    marketHeatState.selectedPlayerKey = decodeURIComponent(
      trigger.dataset.marketHeatPlayer || "",
    );
    if (marketHeatState.report) renderMarketHeatReport(marketHeatState.report);
  });
}
if (marketHeatDetail) {
  marketHeatDetail.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-market-heat-detail-action]");
    if (!trigger) return;
    const action = String(trigger.dataset.marketHeatDetailAction || "").trim().toLowerCase();
    if (action === "recent" || action === "comps") {
      loadMarketHeatPlayerInsight(action);
    }
  });
}
if (listingsLoadButton) {
  listingsLoadButton.addEventListener("click", loadListingsDashboard);
}
if (listingSort) {
  listingSort.addEventListener("change", loadListingsDashboard);
}
if (listingSalesDays) {
  listingSalesDays.addEventListener("change", loadListingsDashboard);
}
if (listingAgeFilter) {
  listingAgeFilter.addEventListener("change", loadListingsDashboard);
}
if (listingSport) {
  listingSport.addEventListener("change", loadListingsDashboard);
}
if (listingSearch) {
  listingSearch.addEventListener("keydown", (event) => {
    if (event.key === "Enter") loadListingsDashboard();
  });
}

/* ── Drive ── */
async function refreshDriveStatus() {
  const status = await api("/api/drive/status");
  driveState.configured = status.configured;
  driveState.connected = status.connected;
  if (!status.configured) {
    driveStatus.textContent = "Drive integration not configured";
  } else if (status.hasWriteScope) {
    driveStatus.textContent = "Drive connected (read/write)";
  } else if (status.hasToken && status.hasReadScope) {
    driveStatus.textContent = "Drive connected (read-only) — reconnect to enable moves";
  } else {
    driveStatus.textContent = status.connected ? "Connected" : "Drive not connected";
  }
  driveConnectButton.style.display = status.configured ? "" : "none";
  driveDisconnectButton.style.display = status.hasToken ? "" : "none";
}

driveConnectButton.addEventListener("click", async () => {
  const { url } = await api("/api/drive/auth-url");
  if (url) window.open(url, "_blank");
});
driveDisconnectButton.addEventListener("click", async () => {
  await api("/api/drive/disconnect", { method: "POST" });
  driveResults.style.display = "none";
  await refreshDriveStatus();
});
driveScanButton.addEventListener("click", async () => {
  const f = driveFolderId.value.trim();
  if (!f) { driveScanMessage.textContent = "Enter a folder ID"; return; }
  driveScanMessage.textContent = "Scanning...";
  driveResults.style.display = "none";
  try {
    const data = await api("/api/drive/scan", { method: "POST", body: JSON.stringify({ folderId: f }) });
    driveState.pairs = data.pairs || [];
    driveState.unmatched = data.unmatched || [];
    driveState.selected = new Set(driveState.pairs.map((_, i) => i));
    renderDriveResults(data);
    driveResults.style.display = "";
    driveScanMessage.textContent = `${data.pairs.length} pairs, ${data.unmatched.length} unmatched`;
  } catch (e) { driveScanMessage.textContent = e.message; }
});

function renderDriveResults(data) {
  const { pairs, unmatched } = data;
  let html = `<div class="drive-scan-summary"><strong>${pairs.length} matched pairs</strong> · ${unmatched.length} unmatched</div>`;
  html += '<div class="drive-pair-list">';
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const checked = driveState.selected.has(i) ? "checked" : "";
    html += `<label class="check-label drive-pair-item"><input type="checkbox" data-pair-idx="${i}" ${checked} /><span class="drive-pair-text">${p.front.name} / ${p.back.name}</span></label>`;
  }
  html += "</div>";
  if (unmatched.length) {
    html += `<details class="unmatched-list"><summary>${unmatched.length} unmatched files</summary>`;
    for (const f of unmatched) html += `<div class="muted unmatched-item">${f.name}</div>`;
    html += "</details>";
  }
  drivePairsList.innerHTML = html;
  driveSummary.textContent = `Folder: ${driveFolderId.value.trim()}\nTotal: ${data.totalFiles}\nImages: ${data.imageFiles}\nPairs: ${pairs.length}\nUnmatched: ${unmatched.length}`;
}

drivePairsList.addEventListener("change", (e) => {
  const cb = e.target.closest("input[data-pair-idx]");
  if (!cb) return;
  const idx = parseInt(cb.dataset.pairIdx, 10);
  if (cb.checked) driveState.selected.add(idx);
  else driveState.selected.delete(idx);
});

driveImportButton.addEventListener("click", async () => {
  const selected = driveState.pairs.filter((_, i) => driveState.selected.has(i));
  if (!selected.length) { driveImportMessage.textContent = "No pairs selected"; return; }
  showProgress("Importing cards from Drive...", 0, `Downloading ${selected.length} pairs from Google Drive`);
  try {
    const result = await api("/api/drive/import", {
      method: "POST",
      body: JSON.stringify({ pairs: selected, folderId: driveFolderId.value.trim() }),
    });
    const { batchId, cardCount } = result;
    driveResults.style.display = "none";
    showProgress("Processing cards...", 0, `0 / ${cardCount} done`);
    if (driveImportPoll) clearInterval(driveImportPoll);
    driveImportPoll = setInterval(async () => {
      try {
        const batchData = await api(`/api/batches/${batchId}`);
        const done = batchData.cards.filter((c) => c.status !== "new" && c.status !== "ocr_pending").length;
        const pct = Math.round((done / cardCount) * 100);
        showProgress("Processing cards...", pct, `${done} / ${cardCount} done`);
        if (done >= cardCount) {
          clearInterval(driveImportPoll);
          driveImportPoll = null;
          driveImportMessage.textContent = `Imported ${cardCount} cards in batch ${batchId}. Refreshing list...`;
          hideProgress();
          await refresh();
          driveImportMessage.textContent = `Imported ${cardCount} cards in batch ${batchId}`;
        }
      } catch { /* poll will retry */ }
    }, 2000);
  } catch (e) {
    if (driveImportPoll) {
      clearInterval(driveImportPoll);
      driveImportPoll = null;
    }
    hideProgress();
    driveImportMessage.textContent = e.message;
  }
});

/* ── Grading tab ── */
gradingDriveScanButton.addEventListener("click", async () => {
  const f = gradingDriveFolderId.value.trim();
  if (!f) { gradingDriveScanMessage.textContent = "Enter a folder ID"; return; }
  writeUiStorage(GRADING_DRIVE_FOLDER_STORAGE_KEY, f);
  gradingDriveScanMessage.textContent = "Scanning...";
  gradingDriveResults.style.display = "none";
  try {
    const data = await api("/api/drive/scan", { method: "POST", body: JSON.stringify({ folderId: f }) });
    gradingState.pairs = data.pairs || [];
    gradingState.unmatched = data.unmatched || [];
    gradingState.selected = new Set(gradingState.pairs.map((_, i) => i));
    renderGradingDriveResults(data);
    gradingDriveResults.style.display = "";
    gradingDriveScanMessage.textContent = `${data.pairs.length} pairs, ${data.unmatched.length} unmatched`;
  } catch (e) { gradingDriveScanMessage.textContent = e.message; }
});

function renderGradingDriveResults(data) {
  const { pairs, unmatched } = data;
  let html = `<div class="drive-scan-summary"><strong>${pairs.length} matched pairs</strong> · ${unmatched.length} unmatched</div>`;
  html += '<div class="drive-pair-list">';
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const checked = gradingState.selected.has(i) ? "checked" : "";
    html += `<label class="check-label drive-pair-item"><input type="checkbox" data-grading-pair-idx="${i}" ${checked} /><span class="drive-pair-text">${p.front.name} / ${p.back.name}</span></label>`;
  }
  html += "</div>";
  if (unmatched.length) {
    html += `<details class="unmatched-list"><summary>${unmatched.length} unmatched files</summary>`;
    for (const f of unmatched) html += `<div class="muted unmatched-item">${f.name}</div>`;
    html += "</details>";
  }
  gradingDrivePairsList.innerHTML = html;
  gradingDriveSummary.textContent = `Folder: ${gradingDriveFolderId.value.trim()}\nTotal: ${data.totalFiles}\nImages: ${data.imageFiles}\nPairs: ${pairs.length}\nUnmatched: ${unmatched.length}`;
}

gradingDrivePairsList.addEventListener("change", (e) => {
  const cb = e.target.closest("input[data-grading-pair-idx]");
  if (!cb) return;
  const idx = parseInt(cb.dataset.gradingPairIdx, 10);
  if (cb.checked) gradingState.selected.add(idx);
  else gradingState.selected.delete(idx);
});

gradingDriveImportButton.addEventListener("click", async () => {
  const selected = gradingState.pairs.filter((_, i) => gradingState.selected.has(i));
  if (!selected.length) { gradingDriveImportMessage.textContent = "No pairs selected"; return; }
  gradingDriveImportMessage.textContent = `Importing ${selected.length} pairs...`;
  try {
    const result = await api("/api/grading/import", {
      method: "POST",
      body: JSON.stringify({ pairs: selected, folderId: gradingDriveFolderId.value.trim() }),
    });
    gradingDriveResults.style.display = "none";
    gradingDriveImportMessage.textContent = `Added ${result.count} card${result.count === 1 ? "" : "s"} to the grading queue.`;
    await loadGradingItems();
  } catch (e) { gradingDriveImportMessage.textContent = e.message; }
});

gradingRefreshButton.addEventListener("click", () => loadGradingItems());

function gradingStatusLabel(item) {
  if (item.status === "pending") return "Not graded yet";
  if (item.status === "grading") return "Grading in progress...";
  if (item.status === "graded") return "Graded";
  if (item.status === "error") return `Error: ${item.error || "unknown"}`;
  if (item.status === "transferred") return "Transferred to listing queue";
  return item.status;
}

function renderGradingItems() {
  const items = gradingState.items.filter((item) => item.status !== "transferred");
  if (!items.length) {
    gradingItemsList.innerHTML = `<div class="empty-state">No cards in the grading queue yet</div>`;
    return;
  }
  gradingItemsList.innerHTML = items.map((item) => {
    const breakdown = item.status === "graded"
      ? `<div class="card-item-details">
          <span class="card-item-detail"><strong>Grade:</strong> ${item.grade ?? "n/a"}${item.gradeLabel ? ` (${item.gradeLabel})` : ""}</span>
          ${item.centering != null ? `<span class="card-item-detail"><strong>Centering:</strong> ${item.centering}</span>` : ""}
          ${item.corners != null ? `<span class="card-item-detail"><strong>Corners:</strong> ${item.corners}</span>` : ""}
          ${item.edges != null ? `<span class="card-item-detail"><strong>Edges:</strong> ${item.edges}</span>` : ""}
          ${item.surface != null ? `<span class="card-item-detail"><strong>Surface:</strong> ${item.surface}</span>` : ""}
        </div>`
      : "";
    return `<div class="card-item" data-grading-id="${item.id}">
      <div class="card-item-header">
        <div class="card-item-title">${item.id}</div>
      </div>
      <div class="grading-item-thumbs">
        ${item.frontImageUrl ? `<img src="${item.frontImageUrl}" alt="front" />` : ""}
        ${item.backImageUrl ? `<img src="${item.backImageUrl}" alt="back" />` : ""}
      </div>
      ${breakdown}
      <div class="card-item-footer">
        <span class="badge ${item.status === "error" ? "bad" : item.status === "graded" ? "good" : ""}">${gradingStatusLabel(item)}</span>
        <div class="card-item-actions">
          <button class="btn btn-sm btn-outline" data-action="get-ai-grade" data-id="${item.id}" ${item.status === "grading" ? "disabled" : ""}>Get AI Grade</button>
          <button class="btn btn-sm btn-outline" data-action="transfer-grading-item" data-id="${item.id}" ${item.status === "grading" ? "disabled" : ""}>Transfer to Listing Queue</button>
          <button class="btn btn-sm btn-outline btn-danger" data-action="discard-grading-item" data-id="${item.id}" ${item.status === "grading" ? "disabled" : ""}>Discard</button>
        </div>
      </div>
    </div>`;
  }).join("");
}

function renderSentToGradingList() {
  const cards = (state.cardItems || []).filter((c) => c.status === "sent_to_grading");
  if (!cards.length) {
    sentToGradingList.innerHTML = `<div class="empty-state">No cards sent to grading</div>`;
    return;
  }
  sentToGradingList.innerHTML = cards.map((card) => {
    const title = [card.candidateYear, card.candidatePlayer, card.candidateSetName, card.candidateCardNumber].filter(Boolean).join(" · ") || card.id;
    return `<div class="card-item" data-card-id="${card.id}">
      <div class="card-item-header">
        <div class="card-item-title">${title}</div>
        <div class="card-item-id">${card.id}</div>
      </div>
      <div class="card-item-footer">
        <span class="badge">Sent to grading</span>
        <div class="card-item-actions">
          <button class="btn btn-sm btn-outline" data-action="return-from-grading" data-id="${card.id}">Return from Grading</button>
        </div>
      </div>
    </div>`;
  }).join("");
}

async function loadGradingItems() {
  try {
    const data = await api("/api/grading");
    gradingState.items = data.gradingItems || [];
    renderGradingItems();
    const anyGrading = gradingState.items.some((item) => item.status === "grading");
    if (anyGrading && !gradingState.pollTimer) {
      gradingState.pollTimer = setInterval(async () => {
        const poll = await api("/api/grading");
        gradingState.items = poll.gradingItems || [];
        renderGradingItems();
        if (!gradingState.items.some((item) => item.status === "grading")) {
          clearInterval(gradingState.pollTimer);
          gradingState.pollTimer = null;
        }
      }, 3000);
    }
  } catch (e) { gradingDriveScanMessage.textContent = e.message; }
}

sendToGradingButton.addEventListener("click", async () => {
  try {
    const id = reviewCardSelect.value;
    if (!id) throw new Error("Select a card first.");
    await api(`/api/card-items/${id}/send-to-grading`, { method: "POST" });
    reviewMessage.textContent = `Sent ${id} to grading`;
    await refresh();
  } catch (e) { reviewMessage.textContent = e.message; }
});

/* ── Review panel ── */
loadReviewCardButton.addEventListener("click", async () => {
  try { await loadReviewCard(reviewCardSelect.value); } catch (e) { reviewMessage.textContent = e.message; }
});
reviewCardSelect.addEventListener("change", async () => {
  try { await loadReviewCard(reviewCardSelect.value); } catch (e) { reviewMessage.textContent = e.message; }
});
saveReviewButton.addEventListener("click", async () => {
  try { await saveReview({ reprocess: false }); } catch (e) { reviewMessage.textContent = e.message; }
});
saveReviewAndProcessButton.addEventListener("click", async () => {
  try { await saveReview({ reprocess: true }); } catch (e) { reviewMessage.textContent = e.message; }
});
approveReviewButton.addEventListener("click", async () => {
  try {
    const id = reviewCardSelect.value;
    if (!id) throw new Error("Select a card first.");
    await api(`/api/card-items/${id}/approve`, { method: "POST" });
    reviewMessage.textContent = `Approved ${id}`;
    await refresh();
    reviewCardSelect.value = id;
    await loadReviewCard(id);
  } catch (e) { reviewMessage.textContent = e.message; }
});

function escapeAttr(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// Editable so a reviewer can correct anything eBay's item specifics show —
// including fields that are otherwise hardcoded (Type, Vintage, Card Size,
// Material, etc.) rather than derived from OCR — without needing dedicated
// UI for every possible specific. Saved via the "Save" button below as
// card.ebaySpecificsOverrides (see /api/card-items/:id/ebay-save), which
// buildItemSpecifics() consults last so it takes precedence over whatever
// it auto-computed. Blanking a field and saving reverts it to that
// auto-computed default rather than clearing it outright.
function renderEbaySpecifics(specifics) {
  if (!specifics || !Object.keys(specifics).length) {
    ebaySpecifics.innerHTML = `<div class="muted">No item specifics.</div>`;
    return;
  }
  const rows = Object.entries(specifics)
    .map(([k, v]) => {
      const value = Array.isArray(v) ? v.join(", ") : String(v ?? "");
      return `<tr>
        <td style="font-weight:600;padding:2px 8px 2px 0;font-size:0.82rem;white-space:nowrap;vertical-align:middle">${k}</td>
        <td style="padding:2px 0"><input type="text" data-specific-key="${escapeAttr(k)}" value="${escapeAttr(value)}" style="width:100%;font-size:0.82rem" /></td>
      </tr>`;
    })
    .join("");
  ebaySpecifics.innerHTML = `<table style="width:100%">${rows}</table>`;
}

function collectEbaySpecificsOverrides() {
  const overrides = {};
  ebaySpecifics.querySelectorAll("input[data-specific-key]").forEach((input) => {
    overrides[input.dataset.specificKey] = input.value;
  });
  return overrides;
}

async function loadEbayPreview(cardId, card, options = {}) {
  try {
    const data = await api(`/api/card-items/${cardId}/ebay-preview`, {
      method: "POST",
      body: JSON.stringify({ force: Boolean(options.force) }),
    });
    ebayListingTitle.value = data.title;
    if (!reviewDescription.value) reviewDescription.value = data.description;
    if (!ebayListingPrice.value || ebayListingPrice.value === "0") ebayListingPrice.value = data.price ?? "";
    renderEbaySpecifics(data.specifics);
    ebayPreviewMessage.textContent = `Title: ${data.title.length} chars · ${Object.keys(data.specifics).length} specifics`;
    if (card) { card.ebayTitle = data.title; card.ebayDescription = data.description; card.ebaySpecifics = data.specifics; }
  } catch (e) { ebayPreviewMessage.textContent = e.message; }
}

loadEbayPreviewButton.addEventListener("click", async () => {
  const id = reviewCardSelect.value;
  if (!id) { ebayPreviewMessage.textContent = "Select a card first."; return; }
  ebayPreviewMessage.textContent = "Refreshing...";
  reviewDescription.value = "";
  await loadEbayPreview(id, null, { force: true });
});

generateReviewDescriptionButton.addEventListener("click", async () => {
  const id = reviewCardSelect.value;
  if (!id) { ebayPreviewMessage.textContent = "Select a card first."; return; }
  ebayPreviewMessage.textContent = "Generating...";
  try {
    const data = await api("/api/ebay/generate-description", { method: "POST", body: JSON.stringify({ cardId: id }) });
    reviewDescription.value = data.description;
    const card = state.cardItems.find((c) => c.id === id);
    if (card) card.ebayDescription = data.description;
    ebayPreviewMessage.textContent = "AI description generated";
  } catch (e) { ebayPreviewMessage.textContent = e.message; }
});

const ebayConfigStatus = document.getElementById("ebayConfigStatus");
const setupEbayButton = document.getElementById("setupEbayButton");
const authorizeEbayButton = document.getElementById("authorizeEbayButton");
const showEbayAuthLinkButton = document.getElementById("showEbayAuthLinkButton");
const copyEbayAuthLinkButton = document.getElementById("copyEbayAuthLinkButton");
const openEbayCallbackButton = document.getElementById("openEbayCallbackButton");
const resetEbayAuthButton = document.getElementById("resetEbayAuthButton");
const ebayAuthLinkOutput = document.getElementById("ebayAuthLinkOutput");
const ebayMinimalAuthLinkOutput = document.getElementById("ebayMinimalAuthLinkOutput");
const ebayBaseAuthLinkOutput = document.getElementById("ebayBaseAuthLinkOutput");
const ebayPortalAuthLinkOutput = document.getElementById("ebayPortalAuthLinkOutput");
let cachedEbayAuthUrl = "";
let cachedEbayCallbackUrl = "";
let cachedEbayMinimalAuthUrl = "";
let cachedEbayBaseAuthUrl = "";
let cachedEbayPortalAuthUrl = "";

function normalizeExternalUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.replace(/^https?:\/\/+/, (match) => match.startsWith("https") ? "https://" : "http://");
}

async function loadEbayAuthData() {
  const [data, minimalData, baseData, portalData] = await Promise.all([
    api("/api/ebay/auth-url?format=json"),
    api("/api/ebay/auth-url?format=json&scopeProfile=minimal"),
    api("/api/ebay/auth-url?format=json&scopeProfile=base"),
    api("/api/ebay/auth-url?format=json&scopeProfile=portal"),
  ]);
  cachedEbayAuthUrl = normalizeExternalUrl(data.url);
  cachedEbayMinimalAuthUrl = normalizeExternalUrl(minimalData.url);
  cachedEbayBaseAuthUrl = normalizeExternalUrl(baseData.url);
  cachedEbayPortalAuthUrl = normalizeExternalUrl(portalData.url);
  cachedEbayCallbackUrl = normalizeExternalUrl(data.callbackUrl);
  ebayAuthLinkOutput.value = cachedEbayAuthUrl;
  ebayMinimalAuthLinkOutput.value = cachedEbayMinimalAuthUrl;
  ebayBaseAuthLinkOutput.value = cachedEbayBaseAuthUrl;
  ebayPortalAuthLinkOutput.value = cachedEbayPortalAuthUrl;
  return data;
}

authorizeEbayButton.addEventListener("click", async () => {
  ebaySetupMessage.textContent = "Redirecting to eBay...";
  window.location.href = "/api/ebay/auth-url";
});
showEbayAuthLinkButton.addEventListener("click", async () => {
  ebaySetupMessage.textContent = "Generating eBay auth link...";
  try {
    const data = await loadEbayAuthData();
    ebaySetupMessage.textContent = data.callbackUrl
      ? `Auth link ready. Callback test: ${data.callbackUrl}`
      : "Auth link ready.";
  } catch (e) {
    ebaySetupMessage.textContent = e.message;
  }
});
copyEbayAuthLinkButton.addEventListener("click", async () => {
  ebaySetupMessage.textContent = "Copying eBay auth link...";
  try {
    const data = cachedEbayAuthUrl ? { url: cachedEbayAuthUrl, callbackUrl: cachedEbayCallbackUrl } : await loadEbayAuthData();
    await navigator.clipboard.writeText(data.url);
    ebaySetupMessage.textContent = "eBay auth link copied to clipboard.";
  } catch (e) {
    ebaySetupMessage.textContent = e.message;
  }
});
openEbayCallbackButton.addEventListener("click", async () => {
  ebaySetupMessage.textContent = "Opening callback test...";
  try {
    const data = cachedEbayCallbackUrl ? { callbackUrl: cachedEbayCallbackUrl } : await loadEbayAuthData();
    window.open(data.callbackUrl || "/api/ebay/auth-callback", "_blank", "noopener,noreferrer");
    ebaySetupMessage.textContent = "Callback test opened in a new tab.";
  } catch (e) {
    ebaySetupMessage.textContent = e.message;
  }
});
setupEbayButton.addEventListener("click", async () => {
  ebaySetupMessage.textContent = "Discovering eBay settings...";
  try {
    const result = await api("/api/ebay/auto-configure", { method: "POST" });
    ebayConfigStatus.textContent = "eBay configured ✓";
    ebayConfigStatus.style.color = "green";
    ebaySetupMessage.textContent = result.message;
  } catch (e) {
    ebayConfigStatus.textContent = "eBay not configured";
    ebayConfigStatus.style.color = "red";
    ebaySetupMessage.textContent = e.message;
  }
});
resetEbayAuthButton.addEventListener("click", async () => {
  if (!confirm("Clear eBay auth tokens and force re-authorization?")) return;
  ebaySetupMessage.textContent = "Resetting eBay auth...";
  try {
    await api("/api/ebay/reset-auth", { method: "POST" });
    ebaySetupMessage.textContent = "eBay auth reset. Reauthorize using Authorize eBay.";
    const config = await api("/api/ebay/config");
    ebayConfigStatus.textContent = config.configured ? "eBay configured ✓" : "eBay not configured";
    ebayConfigStatus.style.color = config.configured ? "green" : "red";
  } catch (e) {
    ebaySetupMessage.textContent = e.message;
  }
});

(async () => {
  try {
    const config = await api("/api/ebay/config");
    ebayConfigStatus.textContent = config.configured ? "eBay configured ✓" : "eBay not configured";
    ebayConfigStatus.style.color = config.configured ? "green" : "red";
  } catch { ebayConfigStatus.textContent = "eBay not configured"; ebayConfigStatus.style.color = "red"; }
})();

createOfferFromReviewButton.addEventListener("click", async () => {
  const id = reviewCardSelect.value;
  if (!id) { ebayPreviewMessage.textContent = "Select a card first."; return; }
  ebayPreviewMessage.textContent = "Creating offer...";
  try {
    const result = await api(`/api/card-items/${id}/offer`, {
      method: "POST",
      body: JSON.stringify(getReviewEbayPayload()),
    });
    ebayPreviewMessage.textContent = `Offer ${result.offer.status} for ${id}`;
    await refresh();
    reviewCardSelect.value = id;
    await loadReviewCard(id);
  } catch (e) { ebayPreviewMessage.textContent = e.message; }
});

createAuctionOfferFromReviewButton.addEventListener("click", async () => {
  const id = reviewCardSelect.value;
  if (!id) { ebayPreviewMessage.textContent = "Select a card first."; return; }
  ebayPreviewMessage.textContent = "Creating auction offer...";
  try {
    const result = await api(`/api/card-items/${id}/offer/auction`, {
      method: "POST",
      body: JSON.stringify(getReviewEbayPayload()),
    });
    ebayPreviewMessage.textContent = `Auction offer ${result.offer.status} for ${id}`;
    await refresh();
    reviewCardSelect.value = id;
    await loadReviewCard(id);
  } catch (e) { ebayPreviewMessage.textContent = e.message; }
});

publishOfferFromReviewButton.addEventListener("click", async () => {
  const d = reviewState.details;
  if (!d?.offer?.id) { ebayPreviewMessage.textContent = "No offer to publish."; return; }
  ebayPreviewMessage.textContent = "Publishing...";
  try {
    showProgress("Publishing to eBay...", 30, "Creating listing...");
    const result = await api(`/api/offers/${d.offer.id}/publish`, { method: "POST" });
    showProgress("Publishing to eBay...", 90, "Almost done...");
    ebayPreviewMessage.textContent = `Published: ${result.offer.listingUrl || "done"}`;
    await refresh();
    reviewCardSelect.value = d.offer.cardItemId;
    await loadReviewCard(d.offer.cardItemId);
    hideProgress();
  } catch (e) { ebayPreviewMessage.textContent = e.message; hideProgress(); }
});

deleteOfferFromReviewButton.addEventListener("click", async () => {
  const d = reviewState.details;
  if (!d?.offer?.id) { ebayPreviewMessage.textContent = "No offer to delete."; return; }
  if (!confirm(`Delete offer ${d.offer.id}?`)) return;
  ebayPreviewMessage.textContent = "Deleting offer...";
  try {
    await api(`/api/offers/${d.offer.id}`, { method: "DELETE" });
    ebayPreviewMessage.textContent = "Offer deleted.";
    await refresh();
  } catch (e) { ebayPreviewMessage.textContent = e.message; }
});

saveEbayListingButton.addEventListener("click", async () => {
  const id = reviewCardSelect.value;
  if (!id) { ebayPreviewMessage.textContent = "Select a card first."; return; }
  ebayPreviewMessage.textContent = "Saving...";
  try {
    const title = ebayListingTitle.value.trim();
    const description = reviewDescription.value.trim();
    const condition = ebayListingCondition.value;
    const price = parseMoneyInput(ebayListingPrice.value);
    const listingConfig = getReviewEbayPayload();
    const categoryId = ebayCategoryId.value.trim();
    const patches = {
      ebayTitle: title,
      ebayDescription: description,
      ebayCategoryId: categoryId,
      specificsOverrides: collectEbaySpecificsOverrides(),
      ...listingConfig,
    };
    if (!isNaN(price) && price > 0) patches.recommendedPrice = price;
    await api(`/api/card-items/${id}/ebay-save`, { method: "POST", body: JSON.stringify(patches) });
    await api(`/api/card-items/${id}`, { method: "PATCH", body: JSON.stringify({ candidateCondition: condition === "LIKE_NEW" ? "graded" : "raw" }) });
    const card = state.cardItems.find((c) => c.id === id);
    if (card) {
      if (title) card.ebayTitle = title;
      if (description) card.ebayDescription = description;
      if (price != null && price > 0) card.recommendedPrice = price;
      card.ebayCategoryId = categoryId;
      Object.assign(card, listingConfig);
    }
    ebayPreviewMessage.textContent = "eBay fields saved";
  } catch (e) { ebayPreviewMessage.textContent = e.message; }
});

ebayListingMode.addEventListener("change", () => {
  applyEbayListingMode(ebayListingMode.value === "auction" ? "AUCTION" : "FIXED_PRICE");
});

function closeReview() {
  reviewOverlay.style.display = "none";
  setReviewOverlayRestore(false);
}
closeReviewButton.addEventListener("click", closeReview);

exportStateButton.addEventListener("click", async () => {
  try {
    const data = await api("/api/export-state");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `state-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    stateMessage.textContent = "Exported";
  } catch (e) { stateMessage.textContent = e.message; }
});
  importStateButton.addEventListener("click", () => importStateFile.click());
  cleanupListedCardsButton.addEventListener("click", async () => {
    if (!confirm("Move existing listed cards into today's dated Drive folder now?")) return;
    try {
      stateMessage.textContent = "Running listed-cards cleanup...";
      const endpoint = "/api/cleanup-listed-drive-cards";
      const requestBody = JSON.stringify({});
      let result;
      try {
        result = await api(endpoint, { method: "POST", body: requestBody });
      } catch (firstError) {
        if (String(firstError.message || "").toLowerCase().includes("404") || String(firstError.message || "").toLowerCase().includes("not found")) {
          result = await api(`${endpoint}/`, { method: "POST", body: requestBody });
        } else {
          throw firstError;
        }
      }
      stateMessage.textContent = `Cleanup complete: eligible=${result.eligibleCount}, moved=${result.movedCount}, skipped=${(result.skippedCardIds || []).length}`;
    } catch (e) { stateMessage.textContent = e.message; }
  });
  seedDataButton.addEventListener("click", async () => {
  try {
    seedMessage.textContent = "Seeding...";
    const result = await api("/api/seed", { method: "POST" });
    seedMessage.textContent = `Seeded ${result.cardCount} cards`;
    await refresh();
  } catch (e) { seedMessage.textContent = e.message; }
});
importStateFile.addEventListener("change", async () => {
  try {
    const file = importStateFile.files[0];
    if (!file) return;
    const text = await file.text();
    const data = JSON.parse(text);
    await api("/api/import-state", { method: "POST", body: JSON.stringify(data) });
    stateMessage.textContent = "Imported. Refreshing...";
    await refresh();
  } catch (e) { stateMessage.textContent = e.message; }
});

loadEbaySetupButton.addEventListener("click", async () => {
  try {
    ebaySetupMessage.textContent = "Loading...";
    const s = await api("/api/ebay/setup");
    ebaySetupMessage.textContent = s.merchantLocationKey ? `Location key ${s.merchantLocationKey}` : "No location yet.";
    ebaySetupOutput.textContent = JSON.stringify(s, null, 2);
  } catch (e) { ebaySetupMessage.textContent = e.message; ebaySetupOutput.textContent = ""; }
});

importApifyButton.addEventListener("click", async () => {
  try {
    const cardId = apifyTargetCard.value;
    if (!cardId) throw new Error("Select a card first.");
    const raw = apifyPayload.value.trim();
    if (!raw) {
      throw new Error("Paste sold comp JSON first.");
    }

    const parsed = JSON.parse(raw);
    const payload = Array.isArray(parsed) ? { rows: parsed } : parsed;
    apifyMessage.textContent = "Importing...";
    const result = await api(`/api/card-items/${cardId}/import-apify-comps`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    apifyMessage.textContent = `Imported ${result.importedCount}, skipped ${result.rejectedCount}.`;
    await refresh();
  } catch (e) { apifyMessage.textContent = e.message; }
});

/* ── Global event delegation ── */
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  const cardEl = event.target.closest(".card-item[data-card-id]");
  const pubCardEl = event.target.closest(".published-card[data-card-id]");

  if (pubCardEl && !event.target.closest("a")) {
    const id = pubCardEl.dataset.cardId;
    const card = state.cardItems.find((c) => c.id === id);
    if (card && card.batchId) {
      batchFilter.value = card.batchId;
      batchFilter.dataset.selected = card.batchId;
      document.querySelector('.nav-item[data-tab="cards"]').click();
      renderReviewCardSelect();
      reviewCardSelect.value = id;
      await loadReviewCard(id);
      openReviewOverlay();
    }
    return;
  }

  if (cardEl && !event.target.closest("button")) {
    const id = cardEl.dataset.cardId;
    const card = state.cardItems.find((c) => c.id === id);
    if (card && card.batchId) {
      batchFilter.value = card.batchId;
      batchFilter.dataset.selected = card.batchId;
      renderReviewCardSelect();
    }
    reviewCardSelect.value = id;
    await loadReviewCard(id);
    openReviewOverlay();
    return;
  }

  if (!button) return;
  const { action, id } = button.dataset;
  try {
    if (action === "process-batch") {
      showProgress("Processing OCR...", 0, "Starting...");
      await api(`/api/batches/${id}/process`, { method: "POST" });
      hideProgress();
    }
    if (action === "create-offers") {
      showProgress("Creating offers...", 0, "Starting...");
      await api(`/api/batches/${id}/offers/create`, { method: "POST" });
      hideProgress();
    }
    if (action === "update-prices") {
      showProgress("Updating prices...", 0, "Starting...");
      await api(`/api/batches/${id}/offers/update-prices`, { method: "POST" });
      hideProgress();
    }
    if (action === "publish-batch") {
      const batch = state.batches.find((b) => b.id === id);
      if (batch?.publishChecklist?.length) {
        const unchecked = batch.publishChecklist.filter((i) => !i.checked);
        if (unchecked.length && !confirm(`${unchecked.length} checklist items not done. Publish anyway?`)) return;
      }
      showProgress("Publishing batch...", 0, "Starting...");
      await api(`/api/batches/${id}/publish`, { method: "POST" });
      hideProgress();
    }
    if (action === "reprocess-card") {
      showProgress("Reprocessing card...", 0, "");
      const updated = await api(`/api/card-items/${id}/process`, { method: "POST" });
      reviewState.cardId = id;
      await refresh();
      reviewCardSelect.value = id;
      await loadReviewCard(id);
      reviewMessage.textContent = `Reprocessed ${id} at $${updated?.recommendedPrice?.toFixed
        ? updated.recommendedPrice.toFixed(2)
        : "n/a"}`;
      hideProgress();
    }
    if (action === "create-card-offer") {
      const result = await api(`/api/card-items/${id}/offer`, { method: "POST" });
      alert(`Offer ${result.offer.status} for ${id}`);
    }
    if (action === "create-card-auction-offer") {
      const result = await api(`/api/card-items/${id}/offer/auction`, { method: "POST" });
      alert(`Auction offer ${result.offer.status} for ${id}`);
    }
    if (action === "approve-card") await api(`/api/card-items/${id}/approve`, { method: "POST" });
    if (action === "send-to-grading-card") await api(`/api/card-items/${id}/send-to-grading`, { method: "POST" });
    if (action === "return-from-grading") await api(`/api/card-items/${id}/return-from-grading`, { method: "POST" });
    if (action === "get-ai-grade") {
      await api(`/api/grading/${id}/submit`, { method: "POST" });
      await loadGradingItems();
      return;
    }
    if (action === "transfer-grading-item") {
      await api(`/api/grading/${id}/transfer`, { method: "POST" });
      await loadGradingItems();
    }
    if (action === "discard-grading-item") {
      if (!confirm(`Discard grading item ${id}?`)) return;
      await api(`/api/grading/${id}`, { method: "DELETE" });
      await loadGradingItems();
      return;
    }
    if (action === "review-card") {
      const card = state.cardItems.find((c) => c.id === id);
      if (card && card.batchId) {
        batchFilter.value = card.batchId;
        batchFilter.dataset.selected = card.batchId;
        renderReviewCardSelect();
      }
      reviewCardSelect.value = id;
      await loadReviewCard(id);
      openReviewOverlay();
    }
    if (action === "review-sales-card") {
      const card = state.cardItems.find((c) => c.id === id);
      if (card && card.batchId) {
        batchFilter.value = card.batchId;
        batchFilter.dataset.selected = card.batchId;
        renderReviewCardSelect();
      }
      reviewCardSelect.value = id;
      await loadReviewCard(id);
      openReviewOverlay();
    }
    if (action === "manual-comp-reprice") {
      const listingId = button.dataset.listingId || "";
      const sku = button.dataset.sku || "";
      const offerId = button.dataset.offerId || "";
      const cardId = button.dataset.cardId || "";
      const title = button.dataset.title || "";
      const currentPrice = parseMoneyInput(button.dataset.price || "");
      listingsStatus.textContent = "Checking repricing target for this listing...";
      try {
        const result = await api("/api/ebay/listings/reprice", {
          method: "POST",
          body: JSON.stringify({
            listingId,
            sku,
            offerId,
            cardId,
            title,
            currentPrice,
          }),
        });
        await loadListingsDashboard();
        listingsStatus.textContent = result?.message || "Repricing refreshed.";
      } catch (error) {
        listingsStatus.textContent = error.message || "Repricing failed.";
        throw error;
      }
      return;
    }
    if (action === "edit-listing-price") {
      const listingId = button.dataset.listingId || "";
      const sku = button.dataset.sku || "";
      const offerId = button.dataset.offerId || "";
      const format = button.dataset.format || "FIXED_PRICE";
      const currentPrice = button.dataset.price || "";
      const nextPrice = window.prompt("Enter new listing price", currentPrice);
      if (nextPrice == null) return;
      const parsedPrice = parseMoneyInput(nextPrice);
      if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
        alert("Please enter a valid price greater than 0.");
        return;
      }
      listingsStatus.textContent = "Updating listing price...";
      await api("/api/ebay/listings/update-price", {
        method: "POST",
        body: JSON.stringify({
          listingId,
          sku,
          offerId,
          format,
          price: parsedPrice,
        }),
      });
      await refresh();
      await loadListingsDashboard();
      listingsStatus.textContent = `Updated price to ${formatSalesMoney(parsedPrice)}.`;
      return;
    }
    if (action === "delete-card") {
      if (!confirm(`Delete ${id}?`)) return;
      if (reviewState.cardId === id) {
        reviewState.cardId = null;
        reviewState.details = null;
      }
      await api(`/api/card-items/${id}`, { method: "DELETE" });
    }
    if (action === "delete-offer") {
      if (!confirm(`Delete offer ${id}?`)) return;
      await api(`/api/offers/${id}`, { method: "DELETE" });
    }
    if (action === "publish-card-offer") {
      if (!confirm("Publish this listing live on eBay now?")) return;
      const result = await api(`/api/offers/${id}/publish`, { method: "POST" });
      alert(
        result?.offer?.status === "published"
          ? `Published: ${result.offer.listingUrl}`
          : `Offer ${result?.offer?.status || "not published"} — check the offer for details.`,
      );
    }
    if (action === "toggle-checklist") {
      const batch = state.batches.find((b) => b.id === id);
      if (batch) {
        const checklist = batch.publishChecklist || [];
        const idx = parseInt(button.dataset.idx, 10);
        if (!isNaN(idx) && checklist[idx]) {
          checklist[idx].checked = !checklist[idx].checked;
          await api(`/api/batches/${id}/checklist`, { method: "POST", body: JSON.stringify({ checklist }) });
        }
      }
    }
    await refresh();
  } catch (e) { alert(e.message); hideProgress(); }
});

document.addEventListener("change", async (event) => {
  const checkbox = event.target.closest("input[data-comp-key]");
  if (!checkbox) return;
  const cardId = checkbox.dataset.cardId;
  const compKey = checkbox.dataset.compKey;
  try {
    await api(`/api/card-items/${cardId}/comp-toggle`, { method: "POST", body: JSON.stringify({ compId: compKey }) });
    await loadReviewCard(cardId);
  } catch (e) { reviewMessage.textContent = e.message; }
});

/* ── Close buttons ── */
document.getElementById("progressCloseButton").addEventListener("click", dismissProgress);

/* ── Init ── */
applySalesRangePreset();
await refreshDriveStatus();
await refresh();
cardRows.appendChild(makeCardRow());
