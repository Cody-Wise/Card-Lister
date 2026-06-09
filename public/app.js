const serverStatus = document.getElementById("serverStatus");
const newBatchButton = document.getElementById("newBatchButton");
const createBatchButton = document.getElementById("createBatchButton");
const addCardRowButton = document.getElementById("addCardRowButton");
const uploadCardsButton = document.getElementById("uploadCardsButton");
const refreshButton = document.getElementById("refreshButton");
const loadEbaySetupButton = document.getElementById("loadEbaySetupButton");
const importApifyButton = document.getElementById("importApifyButton");
const apifyTargetCard = document.getElementById("apifyTargetCard");
const apifySource = document.getElementById("apifySource");
const apifyPayload = document.getElementById("apifyPayload");
const apifyMessage = document.getElementById("apifyMessage");
const activeBatchSelect = document.getElementById("activeBatchSelect");
const batchesList = document.getElementById("batchesList");
const cardsList = document.getElementById("cardsList");
const reviewCardSelect = document.getElementById("reviewCardSelect");
const loadReviewCardButton = document.getElementById("loadReviewCardButton");
const reviewSummary = document.getElementById("reviewSummary");
const reviewPricingEvidence = document.getElementById("reviewPricingEvidence");
const reviewPlayerName = document.getElementById("reviewPlayerName");
const reviewYear = document.getElementById("reviewYear");
const reviewSetName = document.getElementById("reviewSetName");
const reviewCardNumber = document.getElementById("reviewCardNumber");
const reviewParallel = document.getElementById("reviewParallel");
const reviewRookieMode = document.getElementById("reviewRookieMode");
const reviewPrintRun = document.getElementById("reviewPrintRun");
const reviewSerialNumber = document.getElementById("reviewSerialNumber");
const reviewBaseHint = document.getElementById("reviewBaseHint");
const reviewAutoHint = document.getElementById("reviewAutoHint");
const reviewThickCard = document.getElementById("reviewThickCard");
const reviewGrade = document.getElementById("reviewGrade");
const reviewNotes = document.getElementById("reviewNotes");
const saveReviewButton = document.getElementById("saveReviewButton");
const saveReviewAndProcessButton = document.getElementById("saveReviewAndProcessButton");
const approveReviewButton = document.getElementById("approveReviewButton");
const reviewMessage = document.getElementById("reviewMessage");
const cardRows = document.getElementById("cardRows");
const batchMessage = document.getElementById("batchMessage");
const uploadMessage = document.getElementById("uploadMessage");
const ebaySetupMessage = document.getElementById("ebaySetupMessage");
const ebaySetupOutput = document.getElementById("ebaySetupOutput");

let state = {
  batches: [],
  cardItems: []
};

let reviewState = {
  cardId: null,
  details: null
};

function setText(el, value) {
  el.textContent = value;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function makeCardRow() {
  const row = document.createElement("div");
  row.className = "card-row";
  row.innerHTML = `
    <label>
      Front image
      <input type="file" accept="image/*" data-side="front" />
    </label>
    <label>
      Back image
      <input type="file" accept="image/*" data-side="back" />
    </label>
    <label>
      OCR hint / notes
      <input type="text" placeholder="Optional text to help recognition" data-side="notes" />
    </label>
    <label>
      Print run
      <input type="text" placeholder="75 or /75" data-side="printRun" />
    </label>
    <label>
      Parallel
      <input type="text" placeholder="Blue Refractor, Gold, etc." data-side="parallel" />
    </label>
    <label class="check-row">
      <input type="checkbox" data-side="base" />
      Base / no variation
    </label>
    <label class="check-row">
      <input type="checkbox" data-side="auto" />
      Auto / autograph
    </label>
    <label class="check-row">
      <input type="checkbox" data-side="thick" />
      Thick card
    </label>
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
    .map((batch) => `<option value="${batch.id}">${batch.id} - ${batch.status}</option>`)
    .join("");
}

function renderApifyTargetSelect() {
  apifyTargetCard.innerHTML = state.cardItems
    .map((card) => {
      const label = `${card.id} · ${card.candidatePlayer || "Unknown"} · ${card.candidateYear || "----"} · ${card.candidateCardNumber || "?"}`;
      return `<option value="${card.id}">${label}</option>`;
    })
    .join("");
}

function rookieModeFromCard(card) {
  if (!card?.candidateRookieFlag) return "none";
  return /rated rookie/i.test(card.candidateVariantLabel || "") ? "rated" : "generic";
}

function reviewCardLabel(card) {
  return `${card.id} · ${card.candidatePlayer || "Unknown"} · ${card.candidateYear || "----"} · ${card.candidateSetName || "Unknown set"} · ${card.candidateCardNumber || "?"}`;
}

function money(value) {
  if (value == null || Number.isNaN(Number(value))) return "n/a";
  return `$${Number(value).toFixed(2)}`;
}

function renderCompList(title, comps, emptyLabel) {
  const rows = (Array.isArray(comps) ? comps : []).slice(0, 6);
  const items = rows.length
    ? rows.map((comp) => `
      <div class="evidence-item">
        <div class="evidence-title">${comp.title || "Unknown comp"}</div>
        <div class="muted">${comp.source || "unknown"} · ${money(comp.totalPrice ?? comp.price ?? comp.salePrice)}${comp.soldAt ? ` · ${comp.soldAt.slice(0, 10)}` : ""}</div>
        ${comp.url ? `<div class="evidence-url"><a href="${comp.url}" target="_blank" rel="noreferrer">Open listing</a></div>` : ""}
      </div>
    `).join("")
    : `<div class="muted">${emptyLabel}</div>`;
  return `
    <div class="evidence-column">
      <h3>${title}</h3>
      <div class="evidence-list">${items}</div>
    </div>
  `;
}

function renderReviewCardSelect() {
  const preferred = reviewState.cardId && state.cardItems.some((card) => card.id === reviewState.cardId)
    ? reviewState.cardId
    : state.cardItems.find((card) => card.status === "needs_review")?.id || state.cardItems[0]?.id || "";
  if (preferred && preferred !== reviewState.cardId) {
    reviewState.cardId = preferred;
  }
  reviewCardSelect.innerHTML = state.cardItems
    .map((card) => `<option value="${card.id}">${reviewCardLabel(card)}</option>`)
    .join("");
  if (preferred) reviewCardSelect.value = preferred;
}

function renderReviewSummary(detail) {
  if (!detail) {
    reviewSummary.textContent = "Select a card to inspect and edit.";
    reviewPricingEvidence.innerHTML = "";
    return;
  }
  const { card, comps, externalSoldComps } = detail;
  const soldCount = Array.isArray(externalSoldComps) ? externalSoldComps.length : 0;
  const activeCount = Array.isArray(comps) ? comps.filter((comp) => comp.source === "browse_active").length : 0;
  const pricingEvidence = card.pricingEvidence || {};
  const evidenceSoldCount = Array.isArray(pricingEvidence.sold) ? pricingEvidence.sold.length : 0;
  const evidenceActiveCount = Array.isArray(pricingEvidence.active) ? pricingEvidence.active.length : 0;
  const lines = [
    `${card.id}`,
    `${card.candidatePlayer || "Unknown"} · ${card.candidateYear || "----"} · ${card.candidateSetName || "Unknown set"} · ${card.candidateCardNumber || "?"}`,
    `Price: ${card.recommendedPrice == null ? "n/a" : `$${card.recommendedPrice.toFixed(2)}`} · Confidence: ${Math.round((card.confidenceScore || 0) * 100)}%`,
    `Status: ${card.status || "n/a"} · Market: ${card.marketDataSource || "n/a"} · Vision: ${card.ocrProvider || "n/a"}`,
    `Base hint: ${card.candidateBaseHint ? "Yes" : "No"} · Auto hint: ${card.candidateAutoHint ? "Yes" : "No"} · Rookie: ${rookieModeFromCard(card)} · Parallel: ${card.candidateParallel || "n/a"}`,
    `Print run: ${card.printRun || "n/a"}${card.serialNumber ? ` · Serial: ${card.serialNumber}` : ""}`,
    `Sold comps: ${soldCount} Apify · ${activeCount} active`,
    `Pricing evidence: ${evidenceSoldCount} sold used · ${evidenceActiveCount} active used`
  ];
  reviewSummary.textContent = lines.join("\n");
  reviewPricingEvidence.innerHTML = `
    ${renderCompList(
      "Sold comps used",
      pricingEvidence.sold,
      "No sold comps were stored for this price."
    )}
    ${renderCompList(
      "Active listings checked",
      pricingEvidence.active,
      "No active listings were stored for this price."
    )}
  `;
}

async function loadReviewCard(cardId = reviewCardSelect.value) {
  if (!cardId) {
    reviewState.cardId = null;
    reviewState.details = null;
    renderReviewSummary(null);
    return;
  }
  const detail = await api(`/api/card-items/${cardId}`);
  reviewState.cardId = cardId;
  reviewState.details = detail;
  const { card } = detail;
  reviewPlayerName.value = card.candidatePlayer || "";
  reviewYear.value = card.candidateYear || "";
  reviewSetName.value = card.candidateSetName || "";
  reviewCardNumber.value = card.candidateCardNumber || "";
  reviewParallel.value = card.candidateParallel || "";
  reviewRookieMode.value = rookieModeFromCard(card);
  reviewPrintRun.value = card.printRun || "";
  reviewSerialNumber.value = card.serialNumber || "";
  reviewBaseHint.checked = Boolean(card.candidateBaseHint);
  reviewAutoHint.checked = Boolean(card.candidateAutoHint);
  reviewThickCard.checked = Boolean(card.isThickCard);
  reviewGrade.value = card.candidateGrade || "";
  reviewNotes.value = card.notes || "";
  renderReviewSummary(detail);
}

function buildReviewPayload() {
  return {
    playerName: reviewPlayerName.value,
    year: reviewYear.value,
    setName: reviewSetName.value,
    cardNumber: reviewCardNumber.value,
    parallel: reviewParallel.value,
    rookieMode: reviewRookieMode.value,
    printRun: reviewPrintRun.value,
    serialNumber: reviewSerialNumber.value,
    baseHint: reviewBaseHint.checked,
    autographHint: reviewAutoHint.checked,
    thickCard: reviewThickCard.checked,
    grade: reviewGrade.value,
    notes: reviewNotes.value
  };
}

async function saveReview({ reprocess = false } = {}) {
  const cardId = reviewCardSelect.value;
  if (!cardId) throw new Error("Select a card to review.");
  reviewMessage.textContent = reprocess ? "Saving and reprocessing..." : "Saving...";
  const path = reprocess ? `/api/card-items/${cardId}/review` : `/api/card-items/${cardId}`;
  const method = reprocess ? "POST" : "PATCH";
  const result = await api(path, {
    method,
    body: JSON.stringify(buildReviewPayload())
  });
  reviewMessage.textContent = reprocess ? `Saved and reprocessed ${cardId}` : `Saved ${cardId}`;
  await refresh();
  reviewCardSelect.value = cardId;
  await loadReviewCard(cardId);
  if (reprocess && result?.card?.status) {
    reviewMessage.textContent = `Reprocessed ${cardId} · ${result.card.status}`;
  }
}

function statusBadge(status) {
  const className = status === "published" || status === "priced" || status === "ready"
    ? "badge good"
    : status === "needs_review"
      ? "badge warn"
      : "badge";
  return `<span class="${className}">${status}</span>`;
}

function renderBatches() {
  if (!state.batches.length) {
    batchesList.innerHTML = `<div class="muted">No batches yet.</div>`;
    return;
  }
  batchesList.innerHTML = state.batches
    .map((batch) => {
      const count = state.cardItems.filter((card) => card.batchId === batch.id).length;
      return `
        <div class="item">
          <div class="item-head">
            <div>
              <strong>${batch.id}</strong>
              <div class="muted">${batch.source} · ${count} cards</div>
            </div>
            <div class="row">
              ${statusBadge(batch.status)}
              <button class="secondary" data-action="process-batch" data-id="${batch.id}">Process</button>
              <button data-action="create-offers" data-id="${batch.id}">Create offers</button>
              <button class="secondary" data-action="update-prices" data-id="${batch.id}">Update prices</button>
              <button data-action="publish-batch" data-id="${batch.id}">Publish</button>
            </div>
          </div>
          <div class="muted">${batch.notes || ""}</div>
        </div>
      `;
    })
    .join("");
}

function renderCards() {
  if (!state.cardItems.length) {
    cardsList.innerHTML = `<div class="muted">No cards uploaded yet.</div>`;
    return;
  }
  cardsList.innerHTML = state.cardItems
    .map((card) => `
      <div class="item">
        <div class="item-head">
          <div>
            <strong>${card.id}</strong>
            <div class="muted">${card.candidatePlayer || "Unknown player"} · ${card.candidateYear || "----"} · ${card.candidateSetName || "Unknown set"} · ${card.candidateCardNumber || "?"}</div>
            <div class="muted">Price: ${card.recommendedPrice == null ? "n/a" : `$${card.recommendedPrice.toFixed(2)}`} · Confidence: ${Math.round((card.confidenceScore || 0) * 100)}%</div>
            <div class="muted">Thickness: ${card.isThickCard ? "Thick" : "Standard"}</div>
            <div class="muted">Base hint: ${card.candidateBaseHint ? "Yes" : "No"}</div>
            <div class="muted">Auto hint: ${card.candidateAutoHint ? "Yes" : "No"}</div>
            <div class="muted">Parallel: ${card.candidateParallel || "n/a"}</div>
            <div class="muted">Print run: ${card.printRun || "n/a"}${card.serialNumber ? ` · Serial: ${card.serialNumber}` : ""}</div>
            <div class="muted">Vision: ${card.ocrProvider || "n/a"}</div>
            <div class="muted">Sold data: ${card.externalCompSource || "local"}${Array.isArray(card.externalSoldComps) ? ` · ${card.externalSoldComps.length} comps` : ""}</div>
            ${card.apifySearchQuery ? `<div class="muted">Apify queries: ${card.apifySearchQuery}</div>` : ""}
            <div class="muted">Market: ${card.marketDataSource || "n/a"}</div>
            <div class="muted">Reason: ${card.pricingReason || "n/a"}</div>
            ${card.apifyError ? `<div class="muted">Apify: ${card.apifyError}</div>` : ""}
          </div>
          <div class="row">
            ${statusBadge(card.status)}
            <button class="secondary" data-action="review-card" data-id="${card.id}">Review/Edit</button>
            <button class="secondary" data-action="reprocess-card" data-id="${card.id}">Reprocess</button>
            <button class="secondary" data-action="approve-card" data-id="${card.id}">Approve</button>
          </div>
        </div>
      </div>
    `)
    .join("");
}

async function refresh() {
  const boot = await api("/api/bootstrap");
  state = boot;
  renderBatchSelect();
  renderApifyTargetSelect();
  renderReviewCardSelect();
  renderBatches();
  renderCards();
  if (reviewState.cardId) {
    await loadReviewCard(reviewState.cardId);
  } else if (reviewCardSelect.value) {
    await loadReviewCard(reviewCardSelect.value);
  } else {
    renderReviewSummary(null);
  }
  serverStatus.textContent = "Connected";
}

newBatchButton.addEventListener("click", () => {
  cardRows.prepend(makeCardRow());
});

addCardRowButton.addEventListener("click", () => {
  cardRows.appendChild(makeCardRow());
});

createBatchButton.addEventListener("click", async () => {
  try {
    const batch = await api("/api/batches", {
      method: "POST",
      body: JSON.stringify({
        source: document.getElementById("batchSource").value,
        notes: document.getElementById("batchNotes").value
      })
    });
    batchMessage.textContent = `Created ${batch.id}`;
    await refresh();
    activeBatchSelect.value = batch.id;
  } catch (error) {
    batchMessage.textContent = error.message;
  }
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
      const notesInput = row.querySelector('input[data-side="notes"]');
      const printRunInput = row.querySelector('input[data-side="printRun"]');
      const parallelInput = row.querySelector('input[data-side="parallel"]');
      const baseInput = row.querySelector('input[data-side="base"]');
      const autoInput = row.querySelector('input[data-side="auto"]');
      const thickInput = row.querySelector('input[data-side="thick"]');
      if (!frontInput.files[0] || !backInput.files[0]) continue;
      cards.push({
        front: {
          fileName: frontInput.files[0].name,
          dataUrl: await readFileAsDataUrl(frontInput.files[0])
        },
        back: {
          fileName: backInput.files[0].name,
          dataUrl: await readFileAsDataUrl(backInput.files[0])
        },
        notes: notesInput.value,
        printRun: printRunInput.value,
        parallel: parallelInput.value,
        baseCardHint: Boolean(baseInput?.checked) || /\bbase\b/i.test(notesInput.value || ""),
        autoCardHint: Boolean(autoInput?.checked) || /\bauto\b|\bautograph\b|\bsigned\b|\bsignature\b/i.test(notesInput.value || ""),
        thickCard: Boolean(thickInput?.checked)
      });
    }
    if (!cards.length) throw new Error("Add at least one front/back pair.");
    const result = await api(`/api/batches/${batchId}/cards`, {
      method: "POST",
      body: JSON.stringify({ cards })
    });
    uploadMessage.textContent = `Uploaded ${result.created.length} cards`;
    cardRows.innerHTML = "";
    cardRows.appendChild(makeCardRow());
    await refresh();
  } catch (error) {
    uploadMessage.textContent = error.message;
  }
});

refreshButton.addEventListener("click", refresh);

loadReviewCardButton.addEventListener("click", async () => {
  try {
    await loadReviewCard(reviewCardSelect.value);
  } catch (error) {
    reviewMessage.textContent = error.message;
  }
});

reviewCardSelect.addEventListener("change", async () => {
  try {
    await loadReviewCard(reviewCardSelect.value);
  } catch (error) {
    reviewMessage.textContent = error.message;
  }
});

saveReviewButton.addEventListener("click", async () => {
  try {
    await saveReview({ reprocess: false });
  } catch (error) {
    reviewMessage.textContent = error.message;
  }
});

saveReviewAndProcessButton.addEventListener("click", async () => {
  try {
    await saveReview({ reprocess: true });
  } catch (error) {
    reviewMessage.textContent = error.message;
  }
});

approveReviewButton.addEventListener("click", async () => {
  try {
    const cardId = reviewCardSelect.value;
    if (!cardId) throw new Error("Select a card first.");
    await api(`/api/card-items/${cardId}/approve`, { method: "POST" });
    reviewMessage.textContent = `Approved ${cardId}`;
    await refresh();
    reviewCardSelect.value = cardId;
    await loadReviewCard(cardId);
  } catch (error) {
    reviewMessage.textContent = error.message;
  }
});

loadEbaySetupButton.addEventListener("click", async () => {
  try {
    ebaySetupMessage.textContent = "Loading from eBay...";
    const setup = await api("/api/ebay/setup");
    ebaySetupMessage.textContent = setup.merchantLocationKey
      ? `Found location key ${setup.merchantLocationKey}`
      : "No inventory location found yet.";
    ebaySetupOutput.textContent = JSON.stringify(setup, null, 2);
  } catch (error) {
    ebaySetupMessage.textContent = error.message;
    ebaySetupOutput.textContent = "";
  }
});

importApifyButton.addEventListener("click", async () => {
  try {
    const cardId = apifyTargetCard.value;
    if (!cardId) throw new Error("Create or select a card first.");
    const raw = apifyPayload.value.trim();
    if (!raw) throw new Error("Paste Apify JSON first.");
    const parsed = JSON.parse(raw);
    const source = apifySource.value || "apify";
    apifyMessage.textContent = `Importing ${source} data...`;
    const result = await api(`/api/card-items/${cardId}/import-apify-comps`, {
      method: "POST",
      body: JSON.stringify(parsed)
    });
    apifyMessage.textContent = `Imported ${result.importedCount} comps, skipped ${result.rejectedCount}.`;
    await refresh();
  } catch (error) {
    apifyMessage.textContent = error.message;
  }
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  try {
    if (action === "process-batch") await api(`/api/batches/${id}/process`, { method: "POST" });
    if (action === "create-offers") await api(`/api/batches/${id}/offers/create`, { method: "POST" });
    if (action === "update-prices") await api(`/api/batches/${id}/offers/update-prices`, { method: "POST" });
    if (action === "publish-batch") await api(`/api/batches/${id}/publish`, { method: "POST" });
    if (action === "reprocess-card") await api(`/api/card-items/${id}/process`, { method: "POST" });
    if (action === "approve-card") await api(`/api/card-items/${id}/approve`, { method: "POST" });
    if (action === "review-card") {
      reviewCardSelect.value = id;
      await loadReviewCard(id);
      document.getElementById("reviewPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    }
    await refresh();
  } catch (error) {
    alert(error.message);
  }
});

await refresh();
cardRows.appendChild(makeCardRow());
