import { promises as fs } from "node:fs";

// Ximilar's Sports Card Identification API (https://docs.ximilar.com/collectibles/recognition).
// This is a database-lookup identifier (visual similarity against millions of
// known cards), not a text-reading OCR service for the card itself — it
// doesn't read arbitrary text off the card, it recognizes the card as a known
// catalog entry. When it has no confident catalog match, `best_match` comes
// back null and it offers `alternatives` instead, which we surface as a
// low-confidence hint rather than trust outright (validated locally: on one
// test card the top alternative was in fact correct despite no best_match).
//
// When slab_id/slab_grade are requested AND the card is in a graded slab,
// `_objects` contains a SECOND entry named "Slab Label" (distinct from the
// "Card" object) with its own `_identification.best_match` — that's where
// gradingCompany/grade/certificationNumber actually live. This slab_id
// happens to actually read the slab's own OCR label text (accurately, per a
// real PSA-slab test), unlike the main card identification, which is a
// database lookup, not OCR. Confirmed via a real PSA 10 slab test.

const XIMILAR_SPORT_ID_URL = "https://api.ximilar.com/collectibles/v2/sport_id";
// Separate endpoint for trading card games (Pokemon, Magic: The Gathering,
// Yu-Gi-Oh!, Lorcana, One Piece, Digimon, etc) — same request/response shape
// family as sport_id (records/_base64, slab_id/slab_grade, _identification.
// best_match + alternatives, _objects with an optional "Slab Label" entry),
// but best_match fields are TCG-specific (set/set_code/rarity/series/color/
// type instead of team/subcategory/sub_set). See
// https://docs.ximilar.com/collectibles/recognition.
const XIMILAR_TCG_ID_URL = "https://api.ximilar.com/collectibles/v2/tcg_id";

const ROOKIE_CARD_TYPE_RE = /rookie/i;

function hasXimilarConfig() {
  return Boolean(process.env.XIMILAR_API_TOKEN);
}

function ximilarRequestTimeoutMs() {
  const parsed = Number(process.env.XIMILAR_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
}

// Ximilar returns sport names like "Basketball", "MMA" — normalize to the
// lowercase form this app uses elsewhere (see inferSportFromTitle in app.js).
function normalizeSport(value) {
  const raw = String(value || "").trim();
  return raw ? raw.toLowerCase() : null;
}

function firstTagName(tags, key) {
  const entries = tags?.[key];
  return Array.isArray(entries) && entries.length ? entries[0]?.name || null : null;
}

// The "Slab Label" object (present in `_objects` alongside "Card" only when a
// graded slab is detected and slab_id/slab_grade were requested) carries its
// own identification: { name, brand, verbal_grade, grade, year, card_no,
// certificate_number, set, ... } plus a `_tags.Company` tag ("PSA"/"BGS"/etc).
// Confirmed against a real PSA 10 slab locally — `_tags.Company[0].name` and
// `_identification.best_match.{grade,certificate_number}` matched the
// physical label exactly.
function extractSlabFields(record) {
  const slabObject = record?._objects?.find((entry) => entry?.name === "Slab Label") || null;
  if (!slabObject) {
    return { gradingCompany: null, grade: null, certificationNumber: null };
  }
  const match = slabObject._identification?.best_match || null;
  const gradingCompany = firstTagName(slabObject._tags, "Company") || match?.brand || null;
  const grade = match?.grade != null ? String(match.grade) : null;
  const certificationNumber = match?.certificate_number || null;
  return {
    gradingCompany: gradingCompany || null,
    grade: grade || null,
    certificationNumber: certificationNumber || null,
  };
}

function normalizeMatch(match, { isBestMatch, distance }) {
  if (!match) return null;
  const year = match.year != null ? Number(match.year) : null;
  const isRookie = ROOKIE_CARD_TYPE_RE.test(String(match.card_type || ""));
  // Ximilar's serial_number field observed so far looks like a print-run size
  // (e.g. "400"), not a "12/400"-style serial — map it as printRun rather than
  // risk mislabeling a bare number as a specific serial.
  const printRun = match.serial_number ? Number(match.serial_number) : null;

  return {
    playerName: match.name || null,
    year: Number.isFinite(year) ? year : null,
    setName: match.set_name || null,
    cardNumber: match.card_number || null,
    team: match.team || null,
    sport: normalizeSport(match.subcategory),
    rookieFlag: isRookie,
    // sub_set doubles as Ximilar's parallel/colorway field (e.g. "Sparkle",
    // "Purple"); keep it distinct from the rookie-label variantLabel so a
    // caller can actually compare it against another parallel source.
    parallel: match.sub_set || null,
    variantLabel: isRookie ? "Rookie Card" : null,
    printRun: Number.isFinite(printRun) ? printRun : null,
    serialNumber: null,
    fullName: match.full_name || null,
    isBestMatch,
    distance: typeof distance === "number" ? distance : null,
  };
}

// Pure normalizer: takes a parsed sport_id response payload and returns the
// app's standard card-metadata shape. Kept separate from the network call so
// it can be tested against captured real responses without hitting the API.
export function normalizeXimilarPayload(payload) {
  const record = payload?.records?.[0] || null;
  if (record?._status && record._status.code && record._status.code !== 200) {
    throw new Error(`Ximilar image error: ${record._status.text || record._status.code}`);
  }

  // _objects can contain both a "Card" entry and (when a slab is detected) a
  // separate "Slab Label" entry — select the card explicitly rather than
  // assuming index 0, even though that's held true in testing so far.
  const object =
    record?._objects?.find((entry) => entry?.name === "Card") || record?._objects?.[0] || null;
  if (!object) {
    return {
      playerName: null,
      year: null,
      setName: null,
      cardNumber: null,
      team: null,
      sport: null,
      gradedFlag: false,
      gradingCompany: null,
      grade: null,
      certificationNumber: null,
      serialNumber: null,
      printRun: null,
      rookieFlag: false,
      variantLabel: null,
      autographFlag: false,
      confidence: 0,
      notes: "Ximilar: no card detected in image",
      provider: "ximilar",
    };
  }

  const identification = object._identification || {};
  const tags = object._tags || {};
  const gradedFlag = firstTagName(tags, "Graded") === "yes";
  const autographFlag = firstTagName(tags, "Autograph") === "signed";
  const objectConfidence = typeof object.prob === "number" ? object.prob : 0.5;

  let matchInfo;
  let confidence;
  let noteSuffix;
  if (identification.best_match) {
    matchInfo = normalizeMatch(identification.best_match, { isBestMatch: true });
    confidence = objectConfidence;
    noteSuffix = "catalog best match";
  } else {
    const topAlternative = identification.alternatives?.[0] || null;
    const distance = identification.distances?.[0];
    matchInfo = normalizeMatch(topAlternative, { isBestMatch: false, distance });
    // No confirmed catalog match — treat as a low-confidence hint only.
    confidence = topAlternative ? Math.min(0.4, objectConfidence * 0.4) : 0;
    noteSuffix = topAlternative
      ? `no confident catalog match, using closest alternative (distance ${distance ?? "unknown"})`
      : "no catalog match found";
  }

  const slabFields = extractSlabFields(record);

  return {
    playerName: matchInfo?.playerName || null,
    year: matchInfo?.year || null,
    setName: matchInfo?.setName || null,
    cardNumber: matchInfo?.cardNumber || null,
    team: matchInfo?.team || null,
    sport: matchInfo?.sport || null,
    parallel: matchInfo?.parallel || null,
    gradedFlag,
    gradingCompany: slabFields.gradingCompany,
    grade: slabFields.grade,
    certificationNumber: slabFields.certificationNumber,
    serialNumber: matchInfo?.serialNumber || null,
    printRun: matchInfo?.printRun || null,
    rookieFlag: Boolean(matchInfo?.rookieFlag),
    variantLabel: matchInfo?.variantLabel || null,
    autographFlag,
    confidence: Number(confidence.toFixed(2)),
    notes: `Ximilar sport_id: ${noteSuffix}`,
    provider: "ximilar",
  };
}

function normalizeTcgMatch(match, { isBestMatch, distance }) {
  if (!match) return null;
  const year = match.year != null ? Number(match.year) : null;

  return {
    playerName: match.name || null,
    year: Number.isFinite(year) ? year : null,
    setName: match.set || null,
    cardNumber: match.card_number || null,
    // No team concept for TCG cards — series (e.g. a Pokemon expansion's
    // parent series) is the closest analog, kept in its own field rather
    // than overloading `team`.
    series: match.series || null,
    // rarity is the closest TCG analog to a sports card's parallel/insert
    // (e.g. "Rare Holo", "Secret Rare").
    parallel: match.rarity || null,
    variantLabel: match.type || null,
    color: match.color || null,
    setCode: match.set_code || null,
    fullName: match.full_name || null,
    isBestMatch,
    distance: typeof distance === "number" ? distance : null,
  };
}

// Pure normalizer for tcg_id responses — parallel to normalizeXimilarPayload
// but for trading-card-game fields. Returns the same shape the sport_id
// normalizer does (so callers/mergeVisionMetadata don't need to know which
// endpoint produced the result), using `sport` to carry the detected game
// name (e.g. "Pokemon") so the existing inferTradingCardKind keyword match
// in src/services/ebay.js picks up "tcg" correctly downstream.
export function normalizeXimilarTcgPayload(payload) {
  const record = payload?.records?.[0] || null;
  if (record?._status && record._status.code && record._status.code !== 200) {
    throw new Error(`Ximilar image error: ${record._status.text || record._status.code}`);
  }

  const object =
    record?._objects?.find((entry) => entry?.name === "Card") || record?._objects?.[0] || null;
  if (!object) {
    return {
      playerName: null,
      year: null,
      setName: null,
      cardNumber: null,
      team: null,
      sport: null,
      gradedFlag: false,
      gradingCompany: null,
      grade: null,
      certificationNumber: null,
      serialNumber: null,
      printRun: null,
      rookieFlag: false,
      variantLabel: null,
      autographFlag: false,
      confidence: 0,
      notes: "Ximilar: no card detected in image",
      provider: "ximilar",
    };
  }

  const identification = object._identification || {};
  const tags = object._tags || {};
  const gradedFlag = firstTagName(tags, "Graded") === "yes";
  const autographFlag = firstTagName(tags, "Autograph") === "signed";
  const objectConfidence = typeof object.prob === "number" ? object.prob : 0.5;
  // Subcategory carries the specific game (e.g. "Pokemon", "Magic: The
  // Gathering"), same tag key pattern sport_id uses for the sport name.
  const game = firstTagName(tags, "Subcategory");

  let matchInfo;
  let confidence;
  let noteSuffix;
  if (identification.best_match) {
    matchInfo = normalizeTcgMatch(identification.best_match, { isBestMatch: true });
    confidence = objectConfidence;
    noteSuffix = "catalog best match";
  } else {
    const topAlternative = identification.alternatives?.[0] || null;
    const distance = identification.distances?.[0];
    matchInfo = normalizeTcgMatch(topAlternative, { isBestMatch: false, distance });
    confidence = topAlternative ? Math.min(0.4, objectConfidence * 0.4) : 0;
    noteSuffix = topAlternative
      ? `no confident catalog match, using closest alternative (distance ${distance ?? "unknown"})`
      : "no catalog match found";
  }

  const slabFields = extractSlabFields(record);

  return {
    playerName: matchInfo?.playerName || null,
    year: matchInfo?.year || null,
    setName: matchInfo?.setName || null,
    cardNumber: matchInfo?.cardNumber || null,
    team: matchInfo?.series || null,
    sport: game || null,
    parallel: matchInfo?.parallel || null,
    gradedFlag,
    gradingCompany: slabFields.gradingCompany,
    grade: slabFields.grade,
    certificationNumber: slabFields.certificationNumber,
    serialNumber: null,
    printRun: null,
    rookieFlag: false,
    variantLabel: matchInfo?.variantLabel || null,
    autographFlag,
    confidence: Number(confidence.toFixed(2)),
    notes: `Ximilar tcg_id: ${noteSuffix}`,
    provider: "ximilar",
  };
}

async function callXimilarSportId({ base64 }) {
  const token = process.env.XIMILAR_API_TOKEN;
  const response = await fetch(XIMILAR_SPORT_ID_URL, {
    method: "POST",
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
    signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(ximilarRequestTimeoutMs()) : undefined,
    body: JSON.stringify({
      records: [{ _base64: base64 }],
      slab_id: true,
      slab_grade: true,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.status?.text || payload?.detail || `HTTP ${response.status}`;
    throw new Error(`Ximilar sport_id failed (${response.status}): ${message}`);
  }

  const record = payload?.records?.[0] || null;
  if (record?._status && record._status.code && record._status.code !== 200) {
    throw new Error(`Ximilar image error: ${record._status.text || record._status.code}`);
  }

  return normalizeXimilarPayload(payload);
}

async function callXimilarTcgId({ base64 }) {
  const token = process.env.XIMILAR_API_TOKEN;
  const response = await fetch(XIMILAR_TCG_ID_URL, {
    method: "POST",
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
    signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(ximilarRequestTimeoutMs()) : undefined,
    body: JSON.stringify({
      records: [{ _base64: base64 }],
      slab_id: true,
      slab_grade: true,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.status?.text || payload?.detail || `HTTP ${response.status}`;
    throw new Error(`Ximilar tcg_id failed (${response.status}): ${message}`);
  }

  const record = payload?.records?.[0] || null;
  if (record?._status && record._status.code && record._status.code !== 200) {
    throw new Error(`Ximilar image error: ${record._status.text || record._status.code}`);
  }

  return normalizeXimilarTcgPayload(payload);
}

// Identifies a card from its front-image file. Ximilar's sport_id endpoint
// works on a single image (unlike the front+back OpenAI vision pass), so this
// only looks at the front — the side that actually shows the player/set/number.
export async function identifyCardWithXimilar({ imagePath }) {
  if (!hasXimilarConfig()) {
    throw new Error("Missing XIMILAR_API_TOKEN");
  }
  if (!imagePath) {
    throw new Error("identifyCardWithXimilar requires an imagePath");
  }
  const bytes = await fs.readFile(imagePath);
  const base64 = bytes.toString("base64");
  return callXimilarSportId({ base64 });
}

// Same shape/contract as identifyCardWithXimilar, but for trading card games
// (Pokemon, Magic, Yu-Gi-Oh!, etc) via the separate tcg_id endpoint.
export async function identifyTcgCardWithXimilar({ imagePath }) {
  if (!hasXimilarConfig()) {
    throw new Error("Missing XIMILAR_API_TOKEN");
  }
  if (!imagePath) {
    throw new Error("identifyTcgCardWithXimilar requires an imagePath");
  }
  const bytes = await fs.readFile(imagePath);
  const base64 = bytes.toString("base64");
  return callXimilarTcgId({ base64 });
}

export { hasXimilarConfig };
