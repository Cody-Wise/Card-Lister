import { promises as fs } from "node:fs";
import path from "node:path";
import { catalog } from "../data/seed.js";

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

function extractYear(text) {
  const match = /(?:19|20)\d{2}/.exec(text);
  return match ? Number(match[0]) : null;
}

function extractCardNumber(text) {
  const matches = [
    /#\s*([a-z0-9-]+)/i.exec(text),
    /\b(card\s*)?(?:no\.?\s*)?([a-z0-9-]{1,6})\b/i.exec(text)
  ];
  for (const match of matches) {
    if (match) return String(match[1] || match[2]).toUpperCase();
  }
  return null;
}

function extractSerialNumber(text) {
  const match = /\b(\d{1,3})\s*\/\s*(\d{1,4})\b/.exec(text);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
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

function buildHeuristicMetadata({ frontText = "", backText = "", frontFileName = "", backFileName = "" }) {
  const rawText = `${frontText} ${backText} ${frontFileName} ${backFileName}`;
  const haystack = normalizeText(rawText);
  const match = guessCatalogMatch(haystack);
  const chosen = match?.card || null;
  const year = chosen?.year || extractYear(haystack);
  const cardNumber = chosen?.cardNumber || extractCardNumber(haystack);
  const playerName = chosen?.playerName || titleCase(frontText.split("\n")[0] || backText.split("\n")[0] || "");
  const setName = chosen?.setName || null;
  const parallel = chosen?.parallel
    || (/blue\s*wave/i.test(haystack) && /prizm/i.test(haystack) ? "Blue Wave Prizm" : null)
    || (/skymaster/i.test(haystack) ? "SkyMaster" : null);
  const gradedFlag = chosen?.gradedFlag || /psa|sgc|bvg|bgs/i.test(haystack);
  const serialNumber = chosen?.serialNumber || extractSerialNumber(rawText);
  const fileNameSerial = extractSerialNumberFromFileName(frontFileName) || extractSerialNumberFromFileName(backFileName);
  const serialNumberValue = serialNumber || fileNameSerial;
  const printRun = chosen?.printRun || (serialNumberValue ? Number(serialNumberValue.split("/")[1]) : null);
  const gradeMatch = /(psa\s*\d{1,2}|sgc\s*\d{1,2}|bgs\s*\d{1,2}(?:\.5)?|cgc\s*\d{1,2})/i.exec(haystack);
  const grade = chosen?.grade || (gradeMatch ? gradeMatch[1].toUpperCase().replace(/\s+/g, " ") : null);
  const rookieFlag = Boolean(chosen?.rookieFlag || /rated rookie|\brookie\b|\brc\b/i.test(haystack));
  const variantLabel = chosen?.variantLabel || (rookieFlag ? "Rated Rookie" : null);
  const autographFlag = Boolean(chosen?.autographFlag || /\bauto\b|\bautograph\b|\bsigned\b|\bsignature\b/i.test(haystack));

  return {
    playerName: playerName || null,
    year,
    setName,
    cardNumber,
    parallel,
    sport: chosen?.sport || null,
    gradedFlag,
    grade,
    serialNumber: serialNumberValue,
    printRun,
    rookieFlag,
    variantLabel,
    autographFlag,
    confidence: chosen ? 0.9 : 0.45,
    notes: match ? `Matched seed catalog card ${chosen.id}` : "Heuristic OCR parse",
    provider: "heuristic"
  };
}

function normalizeOpenAIResult(result) {
  return {
    playerName: result.playerName || null,
    year: result.year ?? null,
    setName: result.setName || null,
    cardNumber: result.cardNumber || null,
    parallel: result.parallel || null,
    sport: result.sport || null,
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
    candidateCondition: result.gradedFlag ? "graded" : "raw"
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
    grade: update.grade ?? base.grade ?? null,
    serialNumber: update.serialNumber ?? base.serialNumber ?? null,
    printRun: update.printRun ?? base.printRun ?? null,
    rookieFlag: typeof update.rookieFlag === "boolean" ? update.rookieFlag : Boolean(base.rookieFlag),
    variantLabel: update.variantLabel ?? base.variantLabel ?? null,
    autographFlag: typeof update.autographFlag === "boolean" ? update.autographFlag : Boolean(base.autographFlag),
    gradedFlag: typeof update.gradedFlag === "boolean" ? update.gradedFlag : Boolean(base.gradedFlag),
    provider: update.provider === "openai" || base.provider === "openai" ? "openai" : base.provider || "heuristic"
  };

  const confidenceValues = [base.confidence, update.confidence].filter((value) => typeof value === "number");
  merged.confidence = confidenceValues.length
    ? Number((confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length).toFixed(2))
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
          "Content-Type": "application/json"
        },
        signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(30000) : undefined,
        body: JSON.stringify({
          model,
          input: [
            {
              role: "system",
              content: "You extract sports trading card metadata from a single image. Return only the requested JSON schema. Never invent details. If a field is unclear or not visible, use null."
            },
            {
              role: "user",
              content: [
                { type: "input_text", text: prompt },
                { type: "input_image", image_url: dataUrl, detail: "high" },
                { type: "input_text", text: `${sideLabel} file name: ${fileName || "unknown"}` }
              ]
            }
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
                  gradedFlag: { type: "boolean" },
                  grade: nullableString,
                  serialNumber: nullableString,
                  printRun: nullableInteger,
                  rookieFlag: { type: "boolean" },
                  variantLabel: nullableString,
                  autographFlag: { type: "boolean" },
                  confidence: { type: "number" },
                  notes: { type: "string" }
                },
                required: ["playerName", "year", "setName", "cardNumber", "parallel", "sport", "gradedFlag", "grade", "serialNumber", "printRun", "rookieFlag", "variantLabel", "autographFlag", "confidence", "notes"]
              }
            }
          }
        })
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

function mergeVisionResults(front, back) {
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
    metadata?.serialNumber
    || metadata?.printRun
    || /\b(chrome|optic|select|prizm|refractor)\b/.test(setName)
  );
}

export async function extractCardMetadata({ frontText = "", backText = "", frontFileName = "", backFileName = "", frontImagePath = "", backImagePath = "" }) {
  const heuristic = buildHeuristicMetadata({ frontText, backText, frontFileName, backFileName });
  if (hasOpenAIConfig() && (frontImagePath || backImagePath)) {
    try {
      const requests = [];

      if (frontImagePath) {
        requests.push({
          side: "front",
          promise: requestOpenAIVision({
            imagePath: frontImagePath,
            sideLabel: "Front",
            fileName: frontFileName,
            prompt: "Focus on the front of the card. Extract the player identity, year, set name, card number, parallel, and any obvious grade, rookie, or autograph markers. Specifically look for Rated Rookie, Rookie Card, RC, autograph, auto, signature, or similar designations if visible."
          })
        });
      }

      if (backImagePath) {
        requests.push({
          side: "back",
          promise: requestOpenAIVision({
            imagePath: backImagePath,
            sideLabel: "Back",
            fileName: backFileName,
            prompt: "Focus on the back of the card. Extract serial number, print run, exact set or product text, and any confirmatory details."
          })
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
          ...heuristic,
          notes: `OpenAI vision fallback: ${errors.join(" | ") || "No usable image inputs"}`
        };
      }

      let merged = { ...heuristic };
      for (const { side, value } of visionResults) {
        merged = mergeVisionMetadata(merged, value);
        merged.notes = merged.notes ? `${merged.notes} | OpenAI ${side} vision` : `OpenAI ${side} vision`;
      }

      if (frontImagePath && shouldProbeParallel(merged)) {
        try {
          const parallelProbe = await requestOpenAIVision({
            imagePath: frontImagePath,
            sideLabel: "Front",
            fileName: frontFileName,
            prompt: "This is a follow-up focused only on the card parallel or colorway. Identify the exact parallel if it is visible. Look for collector names such as Blue Refractor, Blue Wave, Gold, Black, Silver, Mojo, Hyper, Scope, Ice, Pulsar, Zebra, Lava, Neon Green, Cosmic, and similar parallels. If the front border or foil clearly indicates a blue Topps Chrome / Optic style refractor parallel, call it Blue Refractor only when that is visually supported. Do not change the already-detected player, year, set, or card number unless you are certain."
          });
          const probeFields = {
            parallel: parallelProbe.parallel ?? null,
            variantLabel: parallelProbe.variantLabel ?? null,
            rookieFlag: typeof parallelProbe.rookieFlag === "boolean" ? parallelProbe.rookieFlag : undefined,
            autographFlag: typeof parallelProbe.autographFlag === "boolean" ? parallelProbe.autographFlag : undefined,
            confidence: parallelProbe.confidence,
            notes: parallelProbe.notes
          };
          merged = mergeVisionMetadata(merged, probeFields);
          merged.parallel = parallelProbe.parallel ?? merged.parallel ?? null;
          merged.variantLabel = parallelProbe.variantLabel ?? merged.variantLabel ?? null;
          merged.rookieFlag = typeof parallelProbe.rookieFlag === "boolean" ? parallelProbe.rookieFlag : merged.rookieFlag;
          merged.autographFlag = typeof parallelProbe.autographFlag === "boolean" ? parallelProbe.autographFlag : merged.autographFlag;
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
        ...heuristic,
        notes: `OpenAI vision fallback: ${error.message}`
      };
    }
  }

  return heuristic;
}
