// AI grade-estimation review queue — pulls raw-card image pairs from Google
// Drive, lets a reviewer optionally request a Ximilar card-grader estimate
// (centering/corners/edges/surface/overall grade) per pair, then transfers a
// pair into the normal listing pipeline (batches/cardItems) on demand. This
// is a peer extraction to src/routes/drive-routes.js, not a wrapper around
// it — it imports downloadFile directly from src/services/drive.js. Reuses
// the existing /api/drive/scan route as-is for folder scanning (generic,
// already returns the {pairs, unmatched} shape this needs).
//
// Deliberately does NOT block an HTTP request on the Ximilar submit+poll
// call: this app has a single global state-mutation queue (see
// withState()'s `queue` chaining in src/lib/store.js), so holding a
// withState() callback open across a multi-second-or-longer async job would
// stall every other state-mutating request in the app. Submit responds 202
// immediately; the actual submit+poll runs in a detached background task
// (same shape drive-routes.js already uses for its post-import
// processCardItem calls), finishing with its own separate withState call to
// write results back.
import { readJson, sendJson, notFound } from "../lib/http.js";
import { createAuditEvent, createId, nowIso, withState, getState } from "../lib/store.js";
import { saveImageRecord } from "../lib/storage.js";
import { processCardItem } from "../jobs/pipeline.js";
import { downloadFile } from "../services/drive.js";
import { submitAndPollGrading, readImageAsBase64 } from "../services/ximilar-grading.js";

const GRADING_POLL_TIMEOUT_MS = Math.max(
  10000,
  Number.parseInt(process.env.XIMILAR_GRADING_POLL_TIMEOUT_MS || "120000", 10) || 120000,
);

export async function handleGradingApiRoutes(req, res, { pathname }) {
  if (req.method === "POST" && pathname === "/api/grading/import") {
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

    const created = await withState(async (state) => {
      const createdItems = [];
      for (const downloadedPair of downloadedPairs) {
        const { pair, frontDataUrl, backDataUrl } = downloadedPair;
        const gradingItemId = createId(state, "grading");
        const frontImage = await saveImageRecord(state, {
          gradingItemId,
          side: "front",
          dataUrl: frontDataUrl,
          fileName: pair.front.name,
          skipSupabaseUpload: true,
        });
        const backImage = await saveImageRecord(state, {
          gradingItemId,
          side: "back",
          dataUrl: backDataUrl,
          fileName: pair.back.name,
          skipSupabaseUpload: true,
        });
        state.cardImages.push(frontImage, backImage);
        const gradingItem = {
          id: gradingItemId,
          frontImageId: frontImage.id,
          backImageId: backImage.id,
          driveSourceFolderId: body.folderId || null,
          driveFrontFileId: pair.front.id,
          driveBackFileId: pair.back.id,
          status: "pending",
          ximilarJobId: null,
          grade: null,
          gradeLabel: null,
          centering: null,
          corners: null,
          edges: null,
          surface: null,
          error: null,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          gradedAt: null,
          transferredAt: null,
          transferredCardItemId: null,
        };
        state.gradingItems.push(gradingItem);
        createdItems.push(gradingItem);
        createAuditEvent(state, "gradingItem", gradingItemId, "grading_import", {
          driveFrontFileId: pair.front.id,
          driveBackFileId: pair.back.id,
        });
      }
      return createdItems;
    });

    sendJson(res, 201, { count: created.length, gradingItems: created });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/grading") {
    const snapshot = await getState();
    const now = Date.now();
    const staleIds = (snapshot.gradingItems || [])
      .filter(
        (item) =>
          item.status === "grading" &&
          now - (Date.parse(item.updatedAt || "") || 0) > GRADING_POLL_TIMEOUT_MS,
      )
      .map((item) => item.id);

    if (staleIds.length) {
      await withState(async (state) => {
        for (const item of state.gradingItems || []) {
          if (staleIds.includes(item.id) && item.status === "grading") {
            item.status = "error";
            item.error = `Grading job timed out after ${GRADING_POLL_TIMEOUT_MS}ms (no update received).`;
            item.updatedAt = nowIso();
          }
        }
      });
    }

    const finalState = staleIds.length ? await getState() : snapshot;
    const imagesById = new Map((finalState.cardImages || []).map((img) => [img.id, img]));
    const gradingItems = (finalState.gradingItems || []).map((item) => ({
      ...item,
      frontImageUrl: imagesById.get(item.frontImageId)?.url || null,
      backImageUrl: imagesById.get(item.backImageId)?.url || null,
    }));
    sendJson(res, 200, { gradingItems });
    return true;
  }

  if (
    req.method === "POST" &&
    pathname.startsWith("/api/grading/") &&
    pathname.endsWith("/submit")
  ) {
    const id = pathname.split("/")[3];
    const flip = await withState(async (state) => {
      const item = (state.gradingItems || []).find((entry) => entry.id === id);
      if (!item) return { error: "not_found" };
      if (item.status === "grading") return { error: "already_grading" };
      item.status = "grading";
      item.error = null;
      item.updatedAt = nowIso();
      const frontImage = (state.cardImages || []).find((img) => img.id === item.frontImageId);
      const backImage = (state.cardImages || []).find((img) => img.id === item.backImageId);
      return { ok: true, frontPath: frontImage?.storagePath || null, backPath: backImage?.storagePath || null };
    });

    if (flip.error === "not_found") {
      notFound(res, "Grading item not found");
      return true;
    }
    if (flip.error === "already_grading") {
      sendJson(res, 409, { error: "Grading is already in progress for this item." });
      return true;
    }

    sendJson(res, 202, { status: "grading" });

    (async () => {
      try {
        const [frontBase64, backBase64] = await Promise.all([
          flip.frontPath ? readImageAsBase64(flip.frontPath) : null,
          flip.backPath ? readImageAsBase64(flip.backPath) : null,
        ]);
        const result = await submitAndPollGrading({ frontBase64, backBase64 });
        await withState(async (state) => {
          const item = (state.gradingItems || []).find((entry) => entry.id === id);
          if (!item) return;
          item.status = "graded";
          item.ximilarJobId = result.jobId;
          item.grade = result.grade;
          item.gradeLabel = result.gradeLabel;
          item.centering = result.centering;
          item.corners = result.corners;
          item.edges = result.edges;
          item.surface = result.surface;
          item.gradedAt = nowIso();
          item.updatedAt = nowIso();
        });
      } catch (error) {
        await withState(async (state) => {
          const item = (state.gradingItems || []).find((entry) => entry.id === id);
          if (!item) return;
          item.status = "error";
          item.error = error?.message || String(error);
          item.updatedAt = nowIso();
        });
      }
    })();

    return true;
  }

  if (
    req.method === "POST" &&
    pathname.startsWith("/api/grading/") &&
    pathname.endsWith("/transfer")
  ) {
    const id = pathname.split("/")[3];
    const result = await withState(async (state) => {
      const item = (state.gradingItems || []).find((entry) => entry.id === id);
      if (!item) return { error: "not_found" };
      if (item.status === "grading") return { error: "grading_in_progress" };

      const batch = {
        id: createId(state, "batch"),
        source: "grading_transfer",
        notes: "",
        status: "processing",
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

      const cardItemId = createId(state, "card");
      const frontImage = (state.cardImages || []).find((img) => img.id === item.frontImageId);
      const backImage = (state.cardImages || []).find((img) => img.id === item.backImageId);
      // Relinking cardItemId here is for display/admin-view consistency only
      // — the pipeline finds a card's images by forward reference
      // (cardItem.frontImageId/backImageId), never by reverse lookup through
      // image.cardItemId, so this isn't load-bearing for processCardItem to
      // work correctly.
      if (frontImage) frontImage.cardItemId = cardItemId;
      if (backImage) backImage.cardItemId = cardItemId;

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
        frontImageId: item.frontImageId,
        backImageId: item.backImageId,
        notes: "",
        sku: `${batch.id}-${cardItemId}`,
        status: "ocr_pending",
        driveSourceFolderId: item.driveSourceFolderId || null,
        driveFrontFileId: item.driveFrontFileId || null,
        driveBackFileId: item.driveBackFileId || null,
      };
      state.cardItems.push(cardItem);

      item.status = "transferred";
      item.transferredAt = nowIso();
      item.transferredCardItemId = cardItemId;
      item.updatedAt = nowIso();

      createAuditEvent(state, "batch", batch.id, "grading_transfer", { gradingItemId: id, cardItemId });
      return { ok: true, batchId: batch.id, cardItemId };
    });

    if (result.error === "not_found") {
      notFound(res, "Grading item not found");
      return true;
    }
    if (result.error === "grading_in_progress") {
      sendJson(res, 409, { error: "Grading is in progress for this item — wait for it to finish before transferring." });
      return true;
    }

    sendJson(res, 201, { batchId: result.batchId, cardItemId: result.cardItemId });
    (async () => {
      await processCardItem(result.cardItemId).catch((error) => {
        console.error("Post-transfer card processing failed:", error.message);
      });
    })();
    return true;
  }

  if (req.method === "DELETE" && pathname.startsWith("/api/grading/")) {
    const id = pathname.split("/")[3];
    await withState(async (state) => {
      const idx = (state.gradingItems || []).findIndex((entry) => entry.id === id);
      if (idx === -1) return notFound(res, "Grading item not found");
      state.gradingItems.splice(idx, 1);
      state.cardImages = (state.cardImages || []).filter((img) => img.gradingItemId !== id);
      createAuditEvent(state, "gradingItem", id, "discarded", {});
      return sendJson(res, 200, { ok: true });
    });
    return true;
  }

  return false;
}
