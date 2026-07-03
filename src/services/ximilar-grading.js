// Ximilar's "card-grader" product (https://docs.ximilar.com/collectibles/card-grading) —
// estimates a raw/ungraded card's condition (centering, corners, edges,
// surface) plus an overall 1-10 grade and a condition label. This is a
// SEPARATE product from the synchronous sport_id/tcg_id identification calls
// in src/services/ximilar.js (different auth-scoped billing, per Ximilar's
// pricing), and a different API shape: an async job you submit and poll,
// not a single-request call.
//
// Verified against a real captured job response (2026-07-03, job
// 87eaa5aa-ad41-4675-b783-f1332753244d). The completed job payload's actual
// results live at `payload.response.records[]`, NOT `payload.records[]` —
// the first parseGradingResult() implementation guessed wrong here and
// silently returned all-null fields against a real "DONE" job. Each
// submitted image (front, back) comes back as its OWN independent record
// with its own full `grades: {final, condition, centering, corners, edges,
// surface}` — Ximilar doesn't know two images are the front/back of one
// physical card, so it grades each side separately rather than returning
// one combined card-level result.
import { promises as fs } from "node:fs";

const XIMILAR_GRADING_SUBMIT_URL = "https://api.ximilar.com/account/v2/request/";
const XIMILAR_GRADING_STATUS_URL = "https://api.ximilar.com/account/v2/request/";

export function hasXimilarGradingConfig() {
  // Same token as identification today, but kept as its own check (not an
  // alias of hasXimilarConfig() in ximilar.js) so the UI can show a distinct
  // "grading not configured" message if Ximilar ever issues per-product
  // tokens later.
  return Boolean(process.env.XIMILAR_API_TOKEN);
}

function ximilarGradingTimeoutMs() {
  const parsed = Number(process.env.XIMILAR_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
}

function authHeaders() {
  return {
    Authorization: `Token ${process.env.XIMILAR_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function abortSignal() {
  return typeof AbortSignal?.timeout === "function"
    ? AbortSignal.timeout(ximilarGradingTimeoutMs())
    : undefined;
}

export async function submitGradingJob({ frontBase64, backBase64 }) {
  const records = [frontBase64, backBase64]
    .filter(Boolean)
    .map((base64) => ({ _base64: base64 }));
  if (!records.length) {
    throw new Error("submitGradingJob requires at least one image");
  }

  const response = await fetch(XIMILAR_GRADING_SUBMIT_URL, {
    method: "POST",
    headers: authHeaders(),
    signal: abortSignal(),
    body: JSON.stringify({
      type: "card-grader",
      endpoint: "grade",
      records,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.status?.text || payload?.detail || `HTTP ${response.status}`;
    throw new Error(`Ximilar card-grader submit failed (${response.status}): ${message}`);
  }

  const jobId = payload?.id || payload?.request_id || payload?.job_id || null;
  if (!jobId) {
    throw new Error("Ximilar card-grader submit did not return a job id");
  }
  return { jobId };
}

async function fetchGradingJobStatus(jobId) {
  const response = await fetch(`${XIMILAR_GRADING_STATUS_URL}${jobId}`, {
    method: "GET",
    headers: authHeaders(),
    signal: abortSignal(),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.status?.text || payload?.detail || `HTTP ${response.status}`;
    throw new Error(`Ximilar card-grader status check failed (${response.status}): ${message}`);
  }
  return payload;
}

export async function pollGradingJob(jobId, { timeoutMs = 120000, pollIntervalMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const payload = await fetchGradingJobStatus(jobId);
    const status = String(payload?.status || payload?.state || "").toUpperCase();
    if (status === "DONE" || status === "FINISHED" || status === "SUCCESS") {
      return payload;
    }
    if (status === "FAILED" || status === "ERROR") {
      const message = payload?.status?.text || payload?.error || payload?.detail || "Ximilar reported the grading job failed";
      throw new Error(`Ximilar card-grader job failed: ${message}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Ximilar card-grader job timed out after ${timeoutMs}ms (job ${jobId})`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

function finiteValuesOf(gradeObjects, key) {
  return gradeObjects.map((g) => Number(g?.[key])).filter((v) => Number.isFinite(v));
}

function minOf(gradeObjects, key) {
  const values = finiteValuesOf(gradeObjects, key);
  return values.length ? Math.min(...values) : null;
}

// Still defensive (never throws on an unrecognized shape — returns all
// nulls instead), but now grounded in a real captured response rather than
// docs-only guessing. Combines front/back into one card-level result by
// taking the WORSE (lower) grade per category across whichever sides were
// submitted — matches how professional grading treats the worse side as
// capping the overall grade, and degrades naturally to a single side's own
// numbers when only one image is submitted.
export function parseGradingResult(payload) {
  const empty = { grade: null, gradeLabel: null, centering: null, corners: null, edges: null, surface: null };
  const records = payload?.response?.records || payload?.records || [];
  if (!Array.isArray(records) || !records.length) return empty;

  const gradeObjects = records.map((r) => r?.grades).filter((g) => g && typeof g === "object");
  if (!gradeObjects.length) return empty;

  const grade = minOf(gradeObjects, "final");
  // The limiting (lowest-graded) side's condition label represents the
  // overall call, same reasoning as the numeric grade above.
  const limiting = grade == null ? null : gradeObjects.find((g) => Number(g.final) === grade);

  return {
    grade,
    gradeLabel: typeof limiting?.condition === "string" ? limiting.condition : null,
    centering: minOf(gradeObjects, "centering"),
    corners: minOf(gradeObjects, "corners"),
    edges: minOf(gradeObjects, "edges"),
    surface: minOf(gradeObjects, "surface"),
  };
}

export async function submitAndPollGrading({ frontBase64, backBase64 }, pollOptions = {}) {
  const { jobId } = await submitGradingJob({ frontBase64, backBase64 });
  const payload = await pollGradingJob(jobId, pollOptions);
  return { jobId, ...parseGradingResult(payload) };
}

export async function readImageAsBase64(imagePath) {
  const bytes = await fs.readFile(imagePath);
  return bytes.toString("base64");
}
