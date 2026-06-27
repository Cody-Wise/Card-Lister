import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { catalog } from "../data/seed.js";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const visionOcrScript = path.join(rootDir, "scripts", "vision-ocr.swift");
const visionOcrCacheDir = "/tmp/swift-module-cache";
const suryaRuntimeHome = path.join("/tmp", "surya-home");
const suryaRuntimeCacheRoot = path.join("/tmp", "datalab-cache");
const suryaSnapshotRoot = path.join(
  process.env.HOME || "",
  ".cache",
  "huggingface",
  "hub",
  "models--datalab-to--surya-ocr-2-gguf",
  "snapshots",
);

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleCase(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function guessCatalogMatch(haystack) {
  let best = null;
  for (const card of catalog) {
    let score = 0;
    for (const alias of card.aliases) {
      if (haystack.includes(normalizeText(alias))) score += 2;
    }
    if (haystack.includes(String(card.year))) score += 1;
    if (haystack.includes(normalizeText(card.cardNumber))) score += 1;
    if (score > 0 && (!best || score > best.score)) {
      best = { card, score };
    }
  }
  return best;
}

function likelySameName(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return true;
  return left === right || left.includes(right) || right.includes(left);
}

function extractYear(text) {
  const normalized = normalizeText(text);
  const normalizedSeason = /\b((?:19|20)\d{2})\s+\d{2}\s+(?:panini|topps|upper\s+deck|donruss|bowman|score|optic|prizm|basketball|baseball|football|soccer)\b/i.exec(
    normalized,
  );
  if (normalizedSeason) return Number(normalizedSeason[1]);
  const productSeason = /\b((?:19|20)\d{2})\s*[-/]\s*\d{2}\b[^\n]{0,100}\b(?:panini|topps|upper\s+deck|donruss|bowman|score|optic|prizm|basketball|baseball|football|soccer)\b/i.exec(
    text,
  );
  if (productSeason) return Number(productSeason[1]);
  const productYear = /\b((?:19|20)\d{2})(?:\s*[-/]\s*\d{2})?\s*(?:panini|topps|upper\s+deck|donruss|bowman|score)\b/i.exec(
    text,
  );
  if (productYear) return Number(productYear[1]);
  const match = /(?:19|20)\d{2}/.exec(text);
  return match ? Number(match[0]) : null;
}

function extractCardNumber(text) {
  const matches = [
    /#\s*([a-z0-9-]+)/i.exec(text),
    /\b(?:card\s*)?(?:no\.?|number)\s*([a-z0-9-]{1,8})\b/i.exec(text),
  ];
  for (const match of matches) {
    if (match) return String(match[1]).toUpperCase();
  }
  return null;
}

function extractSetName(text) {
  const haystack = normalizeText(text);
  if (/\bdonruss\s+optic\s+basketball\b/.test(haystack)) return "Donruss Optic Basketball";
  if (/\bdonruss\s+optic\b/.test(haystack)) return "Donruss Optic";
  if (/\bpanini\s+revolution\b/.test(haystack)) return "Panini Revolution";
  if (/\bpanini\s+prizm\b/.test(haystack)) return "Panini Prizm";
  if (/\btopps\s+chrome\b/.test(haystack)) return "Topps Chrome";
  if (/\bpanini\s+select\b/.test(haystack)) return "Panini Select";
  if (/\bpanini\s+donruss\b/.test(haystack)) return "Panini Donruss";
  return null;
}

async function requestLocalVisionOcr(imagePath) {
  if (!imagePath || process.env.LOCAL_VISION_OCR === "0" || process.platform !== "darwin") {
    return "";
  }
  try {
    const { stdout } = await execFileAsync(
      "swift",
      ["-module-cache-path", visionOcrCacheDir, visionOcrScript, imagePath],
      {
        timeout: Math.max(
          2000,
          Math.min(20000, Number.parseInt(process.env.LOCAL_VISION_OCR_TIMEOUT_MS || "10000", 10) || 10000),
        ),
        env: {
          ...process.env,
          CLANG_MODULE_CACHE_PATH: visionOcrCacheDir,
        },
        maxBuffer: 256 * 1024,
      },
    );
    return String(stdout || "").trim();
  } catch {
    return "";
  }
}

async function resolveSuryaLocalModelEnv() {
  if (process.env.SURYA_GGUF_LOCAL_MODEL_PATH && process.env.SURYA_GGUF_LOCAL_MMPROJ_PATH) {
    return {
      SURYA_GGUF_LOCAL_MODEL_PATH: process.env.SURYA_GGUF_LOCAL_MODEL_PATH,
      SURYA_GGUF_LOCAL_MMPROJ_PATH: process.env.SURYA_GGUF_LOCAL_MMPROJ_PATH,
    };
  }
  try {
    const snapshotEntries = await fs.readdir(suryaSnapshotRoot, { withFileTypes: true });
    for (const entry of snapshotEntries) {
      if (!entry.isDirectory()) continue;
      const snapshotDir = path.join(suryaSnapshotRoot, entry.name);
      const modelPath = path.join(snapshotDir, "surya-2.gguf");
      const mmprojPath = path.join(snapshotDir, "surya-2-mmproj.gguf");
      await Promise.all([fs.access(modelPath), fs.access(mmprojPath)]);
      return {
        SURYA_GGUF_LOCAL_MODEL_PATH: modelPath,
        SURYA_GGUF_LOCAL_MMPROJ_PATH: mmprojPath,
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function requestSuryaOcr(imagePath) {
  if (!imagePath || process.env.SURYA_OCR === "0") return "";
  const outputDir = await fs.mkdtemp(path.join("/tmp", "surya-ocr-"));
  try {
    const command = process.env.SURYA_OCR_BIN || "surya_ocr";
    const localModelEnv = await resolveSuryaLocalModelEnv();
    await execFileAsync(command, [imagePath, "--output_dir", outputDir], {
      timeout: Math.max(
        5000,
        Math.min(120000, Number.parseInt(process.env.SURYA_OCR_TIMEOUT_MS || "45000", 10) || 45000),
      ),
      env: {
        ...process.env,
        ...(localModelEnv || {}),
        HOME: process.env.SURYA_RUNTIME_HOME || suryaRuntimeHome,
        CLANG_MODULE_CACHE_PATH: visionOcrCacheDir,
        XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || suryaRuntimeCacheRoot,
        MODEL_CACHE_DIR: process.env.MODEL_CACHE_DIR || path.join(suryaRuntimeCacheRoot, "models"),
        HF_HUB_OFFLINE: localModelEnv ? "1" : process.env.HF_HUB_OFFLINE,
      },
      maxBuffer: 1024 * 1024,
    });
    const key = path.basename(imagePath, path.extname(imagePath));
    let raw = "";
    for (const candidatePath of [path.join(outputDir, "results.json"), path.join(outputDir, key, "results.json")]) {
      try {
        raw = await fs.readFile(candidatePath, "utf8");
        break;
      } catch {
        // keep trying alternate Surya output locations
      }
    }
    if (!raw) return "";
    const parsed = JSON.parse(raw);
    const pages = Array.isArray(parsed?.[key])
      ? parsed[key]
      : Array.isArray(Object.values(parsed || {})[0])
        ? Object.values(parsed)[0]
        : [];
    return pages
      .flatMap((page) => page?.blocks || [])
      .map((block) => stripHtml(block?.html || block?.text || ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  } catch {
    return "";
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
}

function extractSerialNumber(text) {
  const fractionMatch = /\b(\d{1,3})\s*\/\s*(\d{1,4})\b/.exec(text);
  if (fractionMatch) {
    return `${fractionMatch[1]}/${fractionMatch[2]}`;
  }
  const ofMatch = /\b(\d{1,3})\s*(?:of|out of)\s*(\d{1,4})\b/.exec(text);
  if (ofMatch) {
    return `${ofMatch[1]}/${ofMatch[2]}`;
  }
  return null;
}

function extractSerialNumberFromFileName(fileName) {
  const baseName = path.basename(String(fileName || ""));
  const match = /\b(\d{1,3})[-_](\d{1,4})(?:\.[a-z0-9]+)?$/i.exec(baseName);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

function extensionToMimeType(filePath) {
  const extension = path.extname(filePath || "").toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  return "image/png";
}

function filePathToDataUrl(filePath) {
  return fs.readFile(filePath).then((bytes) => {
    const mimeType = extensionToMimeType(filePath);
    return `data:${mimeType};base64,${bytes.toString("base64")}`;
  });
}

function hasOpenAIConfig() {
  return Boolean(process.env.OPENAI_API_KEY);
}

function getOpenAIModelCandidates() {
  const primary = process.env.OPENAI_VISION_MODEL || "gpt-4.1";
  const fallback = primary === "gpt-4.1" ? "gpt-4.1-mini" : "gpt-4.1";
  return [...new Set([primary, fallback])];
}

function buildHeuristicMetadata({
  frontText = "",
  backText = "",
  frontFileName = "",
  backFileName = "",
}) {
  const rawText = `${frontText} ${backText} ${frontFileName} ${backFileName}`;
  const haystack = normalizeText(rawText);
  const rawMatch = guessCatalogMatch(haystack);
  const playerHint =
    /\bwemby\b|\bwembanyama\b/.test(haystack)
      ? {
          playerName: "Victor Wembanyama",
          sport: "basketball",
          team: "San Antonio Spurs",
          league: "NBA",
        }
      : /\bda\s+silva\b/.test(haystack)
        ? {
            playerName: "Tristan Da Silva",
            sport: "basketball",
            team: "Orlando Magic",
            league: "NBA",
          }
        : /\bspears\b/.test(haystack)
          ? {
              playerName: "Tyjae Spears",
              sport: "football",
              team: "Tennessee Titans",
              league: "NFL",
            }
          : /\bchu\b/.test(haystack)
            ? {
                playerName: "Leo Chu",
                sport: "soccer",
              }
            : null;
  const chosen =
    rawMatch?.card && (!playerHint || likelySameName(rawMatch.card.playerName, playerHint.playerName))
      ? rawMatch.card
      : null;
  const match = chosen ? rawMatch : null;
  const year = chosen?.year || extractYear(haystack);
  const cardNumber = chosen?.cardNumber || extractCardNumber(haystack);
  const playerName =
    chosen?.playerName ||
    playerHint?.playerName ||
    titleCase(frontText.split("\n")[0] || backText.split("\n")[0] || "");
  const setName = chosen?.setName || extractSetName(rawText);
  const parallel =
    chosen?.parallel ||
    (/blue\s*wave/i.test(haystack) && /prizm/i.test(haystack) ? "Blue Wave Prizm" : null) ||
    (/\bwave\b/i.test(haystack) ? "Wave" : null) ||
    (/tri\s*-?\s*color/i.test(haystack) ? "Tri-Color" : null) ||
    (/skymaster/i.test(haystack) ? "SkyMaster" : null);
  const gradedFlag = chosen?.gradedFlag || /psa|sgc|bvg|bgs/i.test(haystack);
  const serialNumber = chosen?.serialNumber || extractSerialNumber(rawText);
  const fileNameSerial =
    extractSerialNumberFromFileName(frontFileName) || extractSerialNumberFromFileName(backFileName);
  const serialNumberValue = serialNumber || fileNameSerial;
  const printRun =
    chosen?.printRun || (serialNumberValue ? Number(serialNumberValue.split("/")[1]) : null);
  const gradeMatch = /(psa\s*\d{1,2}|sgc\s*\d{1,2}|bgs\s*\d{1,2}(?:\.5)?|cgc\s*\d{1,2})/i.exec(
    haystack,
  );
  const grade =
    chosen?.grade || (gradeMatch ? gradeMatch[1].toUpperCase().replace(/\s+/g, " ") : null);
  const rookieFlag = Boolean(
    chosen?.rookieFlag || /rated rookie|\brookie\b|\brc\b/i.test(haystack),
  );
  const variantLabel = chosen?.variantLabel || (rookieFlag ? "Rated Rookie" : null);
  const autographFlag = Boolean(
    chosen?.autographFlag || /\bauto\b|\bautograph\b|\bsigned\b|\bsignature\b/i.test(haystack),
  );

  return {
    playerName: playerName || null,
    year,
    setName,
    cardNumber,
    parallel,
    sport: chosen?.sport || playerHint?.sport || null,
    team: chosen?.team || playerHint?.team || null,
    league: chosen?.league || playerHint?.league || null,
    gradedFlag,
    grade,
    serialNumber: serialNumberValue,
    printRun,
    rookieFlag,
    variantLabel,
    autographFlag,
    confidence: chosen ? 0.9 : playerHint ? 0.72 : 0.45,
    notes: match
      ? `Matched seed catalog card ${chosen.id}`
      : playerHint
        ? `Filename/player hint: ${playerHint.playerName}`
        : "Heuristic OCR parse",
    provider: "heuristic",
  };
}

function sanitizeParallel(value) {
  if (!value) return null;
  let s = String(value)
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > 65) s = s.slice(0, 62).trim() + "...";
  return s || null;
}

function isWeakParallel(value) {
  const normalized = normalizeText(value);
  return !normalized || normalized === "base" || normalized === "wave";
}

function deriveIdentityProvider(heuristic, { hasSuryaText = false, hasVisionText = false } = {}) {
  if (hasSuryaText) return "surya";
  if (hasVisionText) return "apple_vision";
  if (String(heuristic?.notes || "").startsWith("Matched seed catalog")) return "seed_catalog";
  if (String(heuristic?.notes || "").startsWith("Filename/player hint")) return "filename_hint";
  return "heuristic";
}

function normalizeOpenAIResult(result) {
  return {
    playerName: result.playerName || null,
    year: result.year ?? null,
    setName: result.setName || null,
    cardNumber: result.cardNumber || null,
    parallel: sanitizeParallel(result.parallel),
    sport: result.sport || null,
    team: result.team || null,
    league: result.league || null,
    gradedFlag: Boolean(result.gradedFlag),
    grade: result.grade || null,
    serialNumber: result.serialNumber || null,
    printRun: result.printRun ?? null,
    rookieFlag: Boolean(result.rookieFlag),
    variantLabel: result.variantLabel || null,
    autographFlag: Boolean(result.autographFlag),
    confidence: typeof result.confidence === "number" ? result.confidence : 0.7,
    notes: result.notes || "OpenAI vision extraction",
    provider: "openai",
    candidateCondition: result.gradedFlag ? "graded" : "raw",
  };
}

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
const nullableInteger = { anyOf: [{ type: "integer" }, { type: "null" }] };

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  const message = payload?.output?.find((entry) => entry.type === "message");
  const content = message?.content || [];
  const outputText = content.find((entry) => entry.type === "output_text" || entry.type === "text");
  if (typeof outputText?.text === "string" && outputText.text.trim()) {
    return outputText.text;
  }
  if (typeof outputText?.content === "string" && outputText.content.trim()) {
    return outputText.content;
  }
  return null;
}

function mergeVisionMetadata(base, update) {
  const merged = {
    ...base,
    ...update,
    playerName: update.playerName ?? base.playerName ?? null,
    year: update.year ?? base.year ?? null,
    setName: update.setName ?? base.setName ?? null,
    cardNumber: update.cardNumber ?? base.cardNumber ?? null,
    parallel: update.parallel ?? base.parallel ?? null,
    sport: update.sport ?? base.sport ?? null,
    team: update.team ?? base.team ?? null,
    league: update.league ?? base.league ?? null,
    grade: update.grade ?? base.grade ?? null,
    serialNumber: update.serialNumber ?? base.serialNumber ?? null,
    printRun: update.printRun ?? base.printRun ?? null,
    rookieFlag:
      typeof update.rookieFlag === "boolean" ? update.rookieFlag : Boolean(base.rookieFlag),
    variantLabel: update.variantLabel ?? base.variantLabel ?? null,
    autographFlag:
      typeof update.autographFlag === "boolean"
        ? update.autographFlag
        : Boolean(base.autographFlag),
    gradedFlag:
      typeof update.gradedFlag === "boolean" ? update.gradedFlag : Boolean(base.gradedFlag),
    provider:
      update.provider === "openai" || base.provider === "openai"
        ? "openai"
        : base.provider || "heuristic",
    identityProvider: base.identityProvider || update.identityProvider || null,
    parallelProvider: update.parallelProvider ?? base.parallelProvider ?? null,
  };

  const confidenceValues = [base.confidence, update.confidence].filter(
    (value) => typeof value === "number",
  );
  merged.confidence = confidenceValues.length
    ? Number(
        (confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length).toFixed(
          2,
        ),
      )
    : 0.45;
  merged.notes = [base.notes, update.notes].filter(Boolean).join(" | ") || "Vision extraction";
  return merged;
}

async function requestOpenAIVision({ imagePath, sideLabel, fileName, prompt }) {
  const dataUrl = await filePathToDataUrl(imagePath);
  let lastError = null;

  for (const model of getOpenAIModelCandidates()) {
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(30000) : undefined,
        body: JSON.stringify({
          model,
          input: [
            {
              role: "system",
              content:
                "You extract sports trading card metadata from a single image. Return only the requested JSON schema. Never invent details. If a field is unclear or not visible, use null.",
            },
            {
              role: "user",
              content: [
                { type: "input_text", text: prompt },
                { type: "input_image", image_url: dataUrl, detail: "high" },
                { type: "input_text", text: `${sideLabel} file name: ${fileName || "unknown"}` },
              ],
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "sports_card_metadata",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  playerName: nullableString,
                  year: nullableInteger,
                  setName: nullableString,
                  cardNumber: nullableString,
                  parallel: nullableString,
                  sport: nullableString,
                  team: nullableString,
                  league: nullableString,
                  gradedFlag: { type: "boolean" },
                  grade: nullableString,
                  serialNumber: nullableString,
                  printRun: nullableInteger,
                  rookieFlag: { type: "boolean" },
                  variantLabel: nullableString,
                  autographFlag: { type: "boolean" },
                  confidence: { type: "number" },
                  notes: { type: "string" },
                },
                required: [
                  "playerName",
                  "year",
                  "setName",
                  "cardNumber",
                  "parallel",
                  "sport",
                  "team",
                  "league",
                  "gradedFlag",
                  "grade",
                  "serialNumber",
                  "printRun",
                  "rookieFlag",
                  "variantLabel",
                  "autographFlag",
                  "confidence",
                  "notes",
                ],
              },
            },
          },
        }),
      });

      const payload = await response.json();
      if (!response.ok) {
        const message = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
        throw new Error(message);
      }

      const text = extractResponseText(payload);
      if (!text) {
        throw new Error("OpenAI returned no structured text output");
      }

      return normalizeOpenAIResult(JSON.parse(text));
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("OpenAI vision extraction failed");
}

async function requestOpenAIParallelVision({ imagePath, fileName, metadata = {} }) {
  const dataUrl = await filePathToDataUrl(imagePath);
  let lastError = null;
  const context = [
    metadata.playerName ? `player: ${metadata.playerName}` : null,
    metadata.year ? `year: ${metadata.year}` : null,
    metadata.setName ? `set: ${metadata.setName}` : null,
    metadata.cardNumber ? `card number: ${metadata.cardNumber}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  for (const model of getOpenAIModelCandidates()) {
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(20000) : undefined,
        body: JSON.stringify({
          model,
          input: [
            {
              role: "system",
              content:
                "You only identify the parallel or variant of a sports trading card image. Do not change player, year, set, or card number. If the parallel is unclear, return null.",
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text:
                    `Identify the exact parallel, colorway, or variant shown on the front of this card. Context: ${context || "unknown card identity"}. ` +
                    "Use collector terms only when visually supported, like Green Seismic, Blue Velocity, Holo, Silver, Wave, Red Wave, Checkerboard, etc. If only a generic parallel family is visible, return that. If nothing specific is visible, return null.",
                },
                { type: "input_image", image_url: dataUrl, detail: "high" },
                { type: "input_text", text: `Front file name: ${fileName || "unknown"}` },
              ],
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "sports_card_parallel",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  parallel: nullableString,
                  variantLabel: nullableString,
                  confidence: { type: "number" },
                  notes: { type: "string" },
                },
                required: ["parallel", "variantLabel", "confidence", "notes"],
              },
            },
          },
        }),
      });

      const payload = await response.json();
      if (!response.ok) {
        const message = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
        throw new Error(message);
      }
      const text = extractResponseText(payload);
      if (!text) throw new Error("OpenAI returned no structured text output");
      const parsed = JSON.parse(text);
      return {
        parallel: sanitizeParallel(parsed.parallel),
        variantLabel: parsed.variantLabel || null,
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
        notes: parsed.notes || "OpenAI parallel detection",
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("OpenAI parallel detection failed");
}

export function mergeVisionResults(front, back) {
  const merged = mergeVisionMetadata(front, back);
  merged.serialNumber = back.serialNumber ?? front.serialNumber ?? null;
  merged.printRun = back.printRun ?? front.printRun ?? null;
  merged.rookieFlag = back.rookieFlag ?? front.rookieFlag ?? false;
  merged.variantLabel = back.variantLabel ?? front.variantLabel ?? null;
  merged.autographFlag = back.autographFlag ?? front.autographFlag ?? false;
  return merged;
}

function shouldProbeParallel(metadata) {
  if (metadata?.parallel) return false;
  const setName = normalizeText(metadata?.setName || "");
  return Boolean(
    metadata?.serialNumber ||
    metadata?.printRun ||
    /\b(chrome|optic|select|prizm|refractor)\b/.test(setName),
  );
}

export async function extractCardMetadata({
  frontText = "",
  backText = "",
  frontFileName = "",
  backFileName = "",
  frontImagePath = "",
  backImagePath = "",
  allowOpenAI = true,
  allowOpenAIParallel = true,
}) {
  const [frontSuryaText, backSuryaText] = await Promise.all([
    requestSuryaOcr(frontImagePath),
    requestSuryaOcr(backImagePath),
  ]);
  const [frontVisionText, backVisionText] = await Promise.all([
    frontText || frontSuryaText ? Promise.resolve("") : requestLocalVisionOcr(frontImagePath),
    backText || backSuryaText ? Promise.resolve("") : requestLocalVisionOcr(backImagePath),
  ]);
  const heuristic = buildHeuristicMetadata({
    frontText: [frontText, frontSuryaText, frontVisionText].filter(Boolean).join("\n"),
    backText: [backText, backSuryaText, backVisionText].filter(Boolean).join("\n"),
    frontFileName,
    backFileName,
  });
  const identityProvider = deriveIdentityProvider(heuristic, {
    hasSuryaText: Boolean(frontSuryaText || backSuryaText),
    hasVisionText: Boolean(frontVisionText || backVisionText),
  });
  const baseMetadata = {
    ...heuristic,
    identityProvider,
    parallelProvider: heuristic.parallel ? identityProvider : null,
  };
  if (allowOpenAI && hasOpenAIConfig() && (frontImagePath || backImagePath)) {
    try {
      const requests = [];

      if (frontImagePath) {
        requests.push({
          side: "front",
          promise: requestOpenAIVision({
            imagePath: frontImagePath,
            sideLabel: "Front",
            fileName: frontFileName,
            prompt:
              "Focus on the front of the card. Extract the player identity, year, set name, card number, parallel, and any obvious grade, rookie, or autograph markers. Specifically look for Rated Rookie, Rookie Card, RC, autograph, auto, signature, or similar designations if visible.",
          }),
        });
      }

      if (backImagePath) {
        requests.push({
          side: "back",
          promise: requestOpenAIVision({
            imagePath: backImagePath,
            sideLabel: "Back",
            fileName: backFileName,
            prompt:
              "Focus on the back of the card. Extract serial number, print run, exact set or product text, and any confirmatory details.",
          }),
        });
      }

      const settled = await Promise.allSettled(requests.map((entry) => entry.promise));
      const visionResults = [];
      const errors = [];

      for (const [index, result] of settled.entries()) {
        const side = requests[index]?.side || "image";
        if (result.status === "fulfilled") {
          visionResults.push({ side, value: result.value });
        } else {
          errors.push(`${side}: ${result.reason?.message || result.reason || "unknown error"}`);
        }
      }

      if (!visionResults.length) {
        return {
          ...baseMetadata,
          notes: `OpenAI vision fallback: ${errors.join(" | ") || "No usable image inputs"}`,
        };
      }

      let merged = { ...baseMetadata };
      for (const { side, value } of visionResults) {
        merged = mergeVisionMetadata(merged, value);
        merged.notes = merged.notes
          ? `${merged.notes} | OpenAI ${side} vision`
          : `OpenAI ${side} vision`;
      }

      if (frontImagePath && shouldProbeParallel(merged)) {
        try {
          const parallelProbe = await requestOpenAIVision({
            imagePath: frontImagePath,
            sideLabel: "Front",
            fileName: frontFileName,
            prompt:
              "This is a follow-up focused only on the card parallel or colorway. Identify the exact parallel if it is visible. Look for collector names such as Blue Refractor, Blue Wave, Gold, Black, Silver, Mojo, Hyper, Scope, Ice, Pulsar, Zebra, Lava, Neon Green, Cosmic, Tri-Color, Tiger Stripe, Checkerboard, Discs, Nebula, Cosmic, and similar parallels. If the front border or foil clearly indicates a blue Topps Chrome / Optic style refractor parallel, call it Blue Refractor only when that is visually supported. Do not change the already-detected player, year, set, or card number unless you are certain.",
          });
          const probeFields = {
            parallel: parallelProbe.parallel ?? null,
            variantLabel: parallelProbe.variantLabel ?? null,
            rookieFlag:
              typeof parallelProbe.rookieFlag === "boolean" ? parallelProbe.rookieFlag : undefined,
            autographFlag:
              typeof parallelProbe.autographFlag === "boolean"
                ? parallelProbe.autographFlag
                : undefined,
            confidence: parallelProbe.confidence,
            notes: parallelProbe.notes,
          };
          merged = mergeVisionMetadata(merged, probeFields);
          merged.parallel = parallelProbe.parallel ?? merged.parallel ?? null;
          merged.variantLabel = parallelProbe.variantLabel ?? merged.variantLabel ?? null;
          merged.rookieFlag =
            typeof parallelProbe.rookieFlag === "boolean"
              ? parallelProbe.rookieFlag
              : merged.rookieFlag;
          merged.autographFlag =
            typeof parallelProbe.autographFlag === "boolean"
              ? parallelProbe.autographFlag
              : merged.autographFlag;
          merged.notes = `${merged.notes} | OpenAI parallel probe`;
        } catch (error) {
          merged.notes = `${merged.notes} | Parallel probe fallback: ${error.message}`;
        }
      }

      if (errors.length) {
        merged.notes = `${merged.notes} | Partial vision fallback: ${errors.join(" | ")}`;
      }

      return merged;
    } catch (error) {
        return {
          ...baseMetadata,
          notes: `OpenAI vision fallback: ${error.message}`,
        };
      }
  }

  if (allowOpenAIParallel && hasOpenAIConfig() && frontImagePath && isWeakParallel(baseMetadata.parallel)) {
    try {
      const parallelProbe = await requestOpenAIParallelVision({
        imagePath: frontImagePath,
        fileName: frontFileName,
        metadata: baseMetadata,
      });
      return mergeVisionMetadata(baseMetadata, {
        parallel: parallelProbe.parallel ?? baseMetadata.parallel ?? null,
        variantLabel: parallelProbe.variantLabel ?? baseMetadata.variantLabel ?? null,
        confidence: parallelProbe.confidence,
        notes: `OpenAI parallel pass: ${parallelProbe.notes}`,
        provider: "openai",
        parallelProvider: parallelProbe.parallel ? "openai_parallel" : baseMetadata.parallelProvider,
      });
    } catch (error) {
      return {
        ...baseMetadata,
        notes: `${baseMetadata.notes} | OpenAI parallel fallback: ${error.message}`,
      };
    }
  }

  return baseMetadata;
}
