// Google Drive import routes — proof-of-concept extraction out of the
// monolithic src/app.js (see README "Known rough edges"). Handles the
// initial folder-scan/import flow only; the post-listing file
// rename/move-into-dated-folder logic stays in app.js since it's a distinct
// concern (cleanup after a card is already listed, not import) that uses a
// different subset of src/services/drive.js.
import { readJson, sendJson } from "../lib/http.js";
import { createAuditEvent, createId, nowIso, withState } from "../lib/store.js";
import { saveImageRecord } from "../lib/storage.js";
import { processCardItem } from "../jobs/pipeline.js";
import {
  getAuthUrl,
  hasDriveConfig,
  getDriveStatus,
  handleCallback,
  disconnect,
  listFolder,
  matchPairs,
  downloadFile,
} from "../services/drive.js";

// Returns true if this route matched and was handled (caller should stop
// processing the request), false otherwise — same convention as
// serveStatic()'s boolean return in app.js.
export async function handleDriveApiRoutes(req, res, { pathname }) {
  if (req.method === "GET" && pathname === "/api/drive/auth-url") {
    const url = getAuthUrl(req);
    if (!url) {
      sendJson(res, 400, { error: "Drive not configured" });
    } else {
      sendJson(res, 200, { url });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/drive/callback") {
    const code = new URL(req.url, "http://localhost").searchParams.get("code");
    if (!code) {
      sendJson(res, 400, { error: "Missing code" });
      return true;
    }
    try {
      const tokens = await handleCallback(code, req);
      sendJson(res, 200, { ok: true, hasRefreshToken: Boolean(tokens.refresh_token) });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/drive/status") {
    sendJson(res, 200, {
      configured: hasDriveConfig(),
      ...(await getDriveStatus()),
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/drive/disconnect") {
    await disconnect();
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/drive/scan") {
    const body = await readJson(req);
    const folderId = body.folderId;
    if (!folderId) {
      sendJson(res, 400, { error: "folderId required" });
      return true;
    }
    try {
      const files = await listFolder(folderId);
      const matched = matchPairs(files);
      sendJson(res, 200, {
        totalFiles: files.length,
        pairs: matched.pairs,
        unmatched: matched.unmatched,
        imageFiles: files.filter((f) => /\.(jpg|jpeg|png|webp|gif|bmp|tiff)$/i.test(f.name)).length,
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/api/drive/import") {
    const body = await readJson(req);
    const pairs = body.pairs;
    if (!Array.isArray(pairs) || pairs.length === 0) {
      sendJson(res, 400, { error: "No pairs to import" });
      return true;
    }
    const importConcurrency = Math.max(
      1,
      Math.min(8, Number.parseInt(process.env.GOOGLE_DRIVE_IMPORT_CONCURRENCY || "6", 10) || 6),
    );
    const downloadedPairs = new Array(pairs.length);
    let nextPairIndex = 0;
    await Promise.all(
      Array.from({ length: Math.min(importConcurrency, pairs.length) }, async () => {
        while (nextPairIndex < pairs.length) {
          const pairIndex = nextPairIndex;
          nextPairIndex += 1;
          const pair = pairs[pairIndex];
          const [frontBuf, backBuf] = await Promise.all([
            downloadFile(pair.front.id),
            downloadFile(pair.back.id),
          ]);
          downloadedPairs[pairIndex] = {
            pair,
            frontDataUrl: `data:${pair.front.mimeType || "image/png"};base64,${frontBuf.toString("base64")}`,
            backDataUrl: `data:${pair.back.mimeType || "image/png"};base64,${backBuf.toString("base64")}`,
          };
        }
      }),
    );

    const result = await withState(async (state) => {
      const batch = {
        id: createId(state, "batch"),
        source: "google_drive",
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
      const created = [];
      for (const downloadedPair of downloadedPairs) {
        const { pair, frontDataUrl, backDataUrl } = downloadedPair;
        const cardItemId = createId(state, "card");
        const frontImage = await saveImageRecord(state, {
          cardItemId,
          side: "front",
          dataUrl: frontDataUrl,
          fileName: pair.front.name,
          skipSupabaseUpload: true,
        });
        const backImage = await saveImageRecord(state, {
          cardItemId,
          side: "back",
          dataUrl: backDataUrl,
          fileName: pair.back.name,
          skipSupabaseUpload: true,
        });
        state.cardImages.push(frontImage, backImage);
        const cardItem = {
          id: cardItemId,
          batchId: batch.id,
          confidenceScore: 0,
          recommendedPrice: null,
          currency: "USD",
          isThickCard: false,
          candidateBaseHint: false,
          candidateAutoHint: false,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          publishState: "draft",
          frontImageId: frontImage.id,
          backImageId: backImage.id,
          notes: pair.notes || "",
          sku: `${batch.id}-${cardItemId}`,
          status: "ocr_pending",
          driveSourceFolderId: body.folderId || null,
          driveFrontFileId: pair.front.id,
          driveBackFileId: pair.back.id,
        };
        state.cardItems.push(cardItem);
        created.push(cardItem);
      }
      batch.updatedAt = nowIso();
      batch.status = "processing";
      createAuditEvent(state, "batch", batch.id, "drive_import", { cardCount: created.length });
      return { batchId: batch.id, createdIds: created.map((c) => c.id) };
    });
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ batchId: result.batchId, cardCount: result.createdIds.length }));
    (async () => {
      const markCardProcessingFailed = async (cardId, error) => {
        await withState(async (state) => {
          const card = (state.cardItems || []).find((item) => item.id === cardId);
          if (!card) return;
          card.status = "needs_review";
          card.ocrProvider = card.ocrProvider || "ebay_image_search";
          card.ocrNotes = [
            card.ocrNotes,
            `Processing fallback: ${error?.message || error || "unknown error"}`,
          ]
            .filter(Boolean)
            .join(" | ");
          card.updatedAt = nowIso();
        });
      };
      for (const cardId of result.createdIds) {
        await processCardItem(cardId).catch((error) => markCardProcessingFailed(cardId, error));
      }
      await withState(async (state) => {
        const batch = (state.batches || []).find((entry) => entry.id === result.batchId);
        if (!batch) return;
        const cards = (state.cardItems || []).filter((item) => item.batchId === result.batchId);
        const open = cards.filter((item) => item.status === "new" || item.status === "ocr_pending");
        const needsReview = cards.some((item) => item.status === "needs_review");
        batch.status = open.length ? "processing" : needsReview ? "needs_review" : "ready_to_publish";
        batch.updatedAt = nowIso();
      });
    })();
    return true;
  }

  return false;
}
