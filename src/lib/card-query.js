// Shared card search-query and title-matching helpers used by apify.js,
// ebay-browse.js, and matching.js. These were previously defined identically
// (or, for a couple, with only structurally-equivalent inlining) in each of
// those files.
//
// Deliberately NOT included here — confirmed diverged, not true duplicates:
//   - matchesCoreCardIdentity: apify.js takes an extra `keyword` param and a
//     parallel-match short-circuit; ebay-browse.js falls back to image-only /
//     title-hint matching when no required fields are present.
//   - scoreListing (apify.js) / scoreTitle (ebay-browse.js): same purpose,
//     different scoring logic for different input shapes (row objects vs.
//     title strings).
//   - dedupeListings: apify.js's fallback dedup key falls back through
//     `totalPrice ?? salePrice ?? ""`; ebay-browse.js's uses only
//     `totalPrice`. A real (if minor) behavioral difference — left as-is
//     rather than silently changed by this extraction.

export function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function cleanQueryText(value) {
  return String(value || "")
    .replace(/["'“”]/g, "")
    .trim();
}

export function hasExplicitVariantSignals(title) {
  const haystack = normalize(title);
  if (!haystack) return false;
  if (/\bbase\b/.test(haystack) || /\bbase card\b/.test(haystack)) return false;
  return (
    /(?:tri\s*color|refractor|prizm|prism|wave|holo|atomic|sparkle|shimmer|die cut|diecut|mojo|scope|hyper|ice|gold|silver|blue|green|red|orange|purple|black|pink|aqua|emerald|lava|laser|raywave|stardust|cracked ice|pulsar|finite|numbered)\b/.test(
      haystack,
    ) || /\b\d{1,3}\s*\/\s*\d{1,4}\b/.test(haystack)
  );
}

export function resolveSearchSetName(metadata = {}, parallelValue = null) {
  const setName = String(metadata.setName || "").trim();
  const normalizedSet = normalize(setName);
  const normalizedParallel = normalize(parallelValue || metadata.parallel || "");
  const wantsChromeStyle = /(refractor|wave|holo|prizm|prism)/.test(normalizedParallel);
  if (
    wantsChromeStyle &&
    /topps/.test(normalizedSet) &&
    /ufc/.test(normalizedSet) &&
    !/chrome/.test(normalizedSet)
  ) {
    return setName.replace(/topps\s+ufc/i, "Topps Chrome UFC");
  }
  return setName;
}

export const SET_IGNORE_WORDS = new Set([
  "basketball",
  "baseball",
  "football",
  "hockey",
  "soccer",
  "ufc",
  "trading",
  "cards",
  "card",
  "sports",
  "sport",
]);

export function setFamilyTokens(value) {
  return normalize(value)
    .split(" ")
    .filter((token) => token && !SET_IGNORE_WORDS.has(token) && !/^\d+$/.test(token));
}

// A serial is "index / print run" — the index can NEVER exceed the run. That
// single rule kills most of the false-positive class this app kept hitting:
//   "7/01"  from a scan filename "Player$7-01.jpg" (price + front/back index)
//   "611/75" from stray digits picked up next to a real run
//   "3/01", "2/01", ... 14 of 42 stored serials were impossible this way.
// A genuine 1-of-1 ("1/1") still passes.
export function isPlausibleSerial(index, printRun) {
  // A print run is never written zero-padded: a genuine one-of-one is "1/1",
  // never "1/01". The padded form is a front/back file index, which is how a
  // base Stephen Curry and a base Martinez were both stored as 1-of-1s — the
  // magnitude check below cannot catch those, since 1 <= 1.
  if (typeof printRun === "string" && /^0\d/.test(printRun.trim())) return false;
  if (typeof index === "string" && /^0\d/.test(index.trim()) && String(printRun).trim().length < 2) {
    return false;
  }
  const i = Number(index);
  const run = Number(printRun);
  if (!Number.isFinite(i) || !Number.isFinite(run)) return false;
  if (i < 1 || run < 1) return false;
  if (i > run) return false;
  // Print runs above this are not a real thing on a numbered card; a match
  // that large is a year, a barcode or a price, not a serial.
  if (run > 25000) return false;
  return true;
}

// "No. 10 of 60", "Card 10 of 60" is SET numbering (card 10 in a 60-card set),
// not a serial. 1970 Super Stars Dick Butkus was being stored as /60 because
// of this.
export function looksLikeSetNumbering(text, matchIndex) {
  const before = String(text || "").slice(Math.max(0, matchIndex - 14), matchIndex);
  return /\b(?:no\.?|number|card|#)\s*$/i.test(before);
}

export function parsePrintRunFromSerial(value) {
  const serial = String(value || "");
  const slashMatch = /\b(\d{1,4})\s*\/\s*(\d{1,5})\b/.exec(serial);
  if (slashMatch && isPlausibleSerial(slashMatch[1], slashMatch[2])) return Number(slashMatch[2]);
  const ofMatch = /\b(\d{1,4})\s*(?:of|out of)\s*(\d{1,5})\b/i.exec(serial);
  if (ofMatch && !looksLikeSetNumbering(serial, ofMatch.index) && isPlausibleSerial(ofMatch[1], ofMatch[2])) {
    return Number(ofMatch[2]);
  }
  return null;
}

export function inferParallelHint(metadata = {}) {
  if (metadata.baseHint) return null;
  if (metadata.parallel) return null;
  if (!(metadata.serialNumber || metadata.printRun)) return null;
  const setName = normalize(metadata.setName || "");
  if (/(chrome|refractor)/.test(setName)) return "Blue Refractor";
  if (/optic/.test(setName)) return "Holo";
  if (/select/.test(setName)) return "Blue";
  if (/prizm/.test(setName)) return "Silver Prizm";
  return null;
}

export function numberingSearchToken(metadata = {}) {
  if (metadata.printRun) return `/${metadata.printRun}`;
  const serial = String(metadata.serialNumber || "");
  const run = parsePrintRunFromSerial(serial);
  if (run != null) return `/${run}`;
  if (/^\d+$/.test(serial)) return serial;
  return null;
}

export function derivedPrintRun(metadata = {}) {
  if (metadata.printRun) return metadata.printRun;
  return parsePrintRunFromSerial(metadata.serialNumber);
}

export function autographSearchTokens(metadata = {}) {
  return metadata.autographFlag ? ["Autograph"] : [];
}

export function autographTitleMatches(title, metadata = {}) {
  if (!metadata.autographFlag) return true;
  const haystack = normalize(title);
  return (
    /\bautograph\b/.test(haystack) ||
    /\bsignature\b/.test(haystack) ||
    /\bsigned\b/.test(haystack) ||
    /\bauto\b/.test(haystack)
  );
}

export function rookieStyleFromMetadata(metadata = {}) {
  const setName = normalize(metadata.setName || "");
  const variantLabel = normalize(metadata.variantLabel || "");
  return /rated rookie/.test(variantLabel) || /optic/.test(setName) ? "rated" : "generic";
}

export function rookieTitleMatches(title, metadata = {}) {
  if (!metadata.rookieFlag) return true;
  const haystack = normalize(title);
  const style = rookieStyleFromMetadata(metadata);
  if (style === "generic" && haystack.includes("rated rookie")) return false;
  if (style === "rated")
    return (
      haystack.includes("rated rookie") ||
      /\brc\b/.test(haystack) ||
      haystack.includes("rookie card")
    );
  return haystack.includes("rookie") || /\brc\b/.test(haystack);
}

export function rookieSearchTokens(metadata = {}) {
  if (!metadata.rookieFlag) return [];
  return rookieStyleFromMetadata(metadata) === "rated" ? ["Rated Rookie", "RC"] : ["Rookie", "RC"];
}

export function parallelMatchesTitle(title, parallel) {
  const haystack = normalize(title);
  const needle = normalize(parallel);
  if (!needle) return true;
  if (haystack.includes(needle)) return true;
  const parts = needle.split(" ").filter(Boolean);
  if (parts.length > 1 && parts.every((part) => haystack.includes(part))) return true;
  if (needle.includes("blue refractor")) {
    return (
      haystack.includes("blue") &&
      (haystack.includes("refractor") || haystack.includes("chrome") || haystack.includes("optic"))
    );
  }
  if (needle.includes("blue wave")) {
    return haystack.includes("blue") && haystack.includes("wave");
  }
  if (needle.includes("silver prizm") || needle.includes("silver prism")) {
    return (
      haystack.includes("silver") && (haystack.includes("prizm") || haystack.includes("prism"))
    );
  }
  if (needle.includes("holo")) {
    return haystack.includes("holo") || (haystack.includes("optic") && haystack.includes("silver"));
  }
  if (needle.includes("gold")) {
    return haystack.includes("gold");
  }
  if (needle.includes("tri") && needle.includes("color")) {
    return haystack.includes("tri") && haystack.includes("color");
  }
  return false;
}

export function buildYearFirstParts(metadata = {}, { includeParallel = true } = {}) {
  const numberingToken = numberingSearchToken(metadata);
  return [
    metadata.year,
    metadata.playerName,
    metadata.searchSetName || metadata.setName,
    metadata.cardNumber,
    includeParallel ? metadata.parallel : null,
    numberingToken,
    ...autographSearchTokens(metadata),
    ...rookieSearchTokens(metadata),
  ]
    .map(cleanQueryText)
    .filter(Boolean);
}
