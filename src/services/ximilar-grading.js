// Ximilar's "card-grader" product (https://docs.ximilar.com/collectibles/card-grading) —
// estimates a raw/ungraded card's condition (centering, corners, edges,
// surface) plus an overall 1-10 grade and Poor-Gem Mint label. This is a
// SEPARATE product from the synchronous sport_id/tcg_id identification calls
// in src/services/ximilar.js (different auth-scoped billing, per Ximilar's
// pricing), and a different API shape: an async job you submit and poll,
// not a single-request call.
//
// IMPORTANT: the exact response shape below is built from Ximilar's
// documentation only — no real card-grader response has been captured in
// this repo (unlike sport_id/tcg_id, which do have captured-response test
// fixtures). parseGradingResult() is deliberately defensive (never throws on
// an unrecognized shape) so a docs/reality mismatch surfaces as a clear
// per-item error in the UI instead of crashing. Treat the first real
// submission as a live smoke test, the same way SoldComps got one before
// being trusted in production.
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

function firstFinite(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

// Defensive on purpose — see file header. Looks in several plausible
// locations for the fields Ximilar's docs describe, rather than assuming one
// exact shape, and never throws on a shape it doesn't recognize.
export function parseGradingResult(payload) {
  const record =
    payload?.records?.[0] ||
    payload?.result?.records?.[0] ||
    payload?.result ||
    payload ||
    {};

  const gradeSection = record?.grade || record?._grade || record;
  const conditionSection = record?.condition || record?._condition || record;

  const grade = firstFinite(
    gradeSection?.grade,
    gradeSection?.overall,
    gradeSection?.final_grade,
    record?.grade,
  );
  const gradeLabel = firstString(
    gradeSection?.label,
    gradeSection?.grade_label,
    record?.label,
  );

  const centering = firstFinite(conditionSection?.centering, record?.centering);
  const corners = firstFinite(conditionSection?.corners, record?.corners);
  const edges = firstFinite(conditionSection?.edges, record?.edges);
  const surface = firstFinite(conditionSection?.surface, record?.surface);

  return { grade, gradeLabel, centering, corners, edges, surface };
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
