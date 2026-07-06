function sortNumbers(values) {
  return [...values].sort((a, b) => a - b);
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function median(values) {
  if (!values.length) return null;
  const sorted = sortNumbers(values);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = sortNumbers(values);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentileValue)),
  );
  return sorted[index];
}

export function trimOutliers(values) {
  if (values.length < 4) return values;
  const sorted = sortNumbers(values);
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const iqr = q3 - q1;
  const low = q1 - 1.5 * iqr;
  const high = q3 + 1.5 * iqr;
  return sorted.filter((value) => value >= low && value <= high);
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function compPrice(comp) {
  if (typeof comp.serialRunAdjustedPrice === "number" && Number.isFinite(comp.serialRunAdjustedPrice)) {
    return Number(comp.serialRunAdjustedPrice);
  }
  const salePrice = Number(comp.salePrice ?? comp.sale_price ?? 0);
  const totalPrice = Number(comp.totalPrice ?? comp.total_price ?? comp.price ?? 0);
  const hasSalePrice = Number.isFinite(salePrice) && salePrice > 0;
  const hasTotalPrice = Number.isFinite(totalPrice) && totalPrice > 0;
  if (hasSalePrice && hasTotalPrice) {
    return Math.max(salePrice, totalPrice);
  }
  if (hasSalePrice) {
    return salePrice;
  }
  if (hasTotalPrice) {
    return totalPrice;
  }
  return 0;
}

function compSnapshot(comp, source) {
  return {
    source: comp.source || source || null,
    listingId: comp.listingId || null,
    title: comp.title || comp.name || comp.keyword || null,
    conditionLabel: comp.conditionLabel || null,
    salePrice: comp.salePrice ?? comp.sale_price ?? null,
    shippingPrice: comp.shippingPrice ?? null,
    totalPrice: comp.totalPrice ?? comp.total_price ?? comp.price ?? null,
    printRun: comp.printRun ?? comp.print_run ?? comp.printRunHint ?? null,
    serialNumber: comp.serialNumber ?? comp.serial_number ?? null,
    soldAt: comp.soldAt || null,
    url: comp.url || null,
    matchScore: comp.matchScore ?? null,
    isBestOfferAccepted: Boolean(comp.isBestOfferAccepted),
    listingType: comp.listingType || null,
    sellerUsername: comp.sellerUsername || null,
  };
}

function hasBaseSignal(haystack) {
  return /\bbase\b|\bbase card\b/.test(haystack);
}

function isBaseTitle(title = "") {
  return hasBaseSignal(normalizeText(title));
}

function hasParallelSignal(text = "") {
  const haystack = normalizeText(text);
  return (
    /(?:\b\d{1,3}\s*\/\s*\d{1,4}\b|(?:tri\s*color|refractor|prizm|prism|wave|holo|atomic|sparkle|shimmer|die cut|diecut|mojo|scope|hyper|ice|gold|silver|blue|green|red|orange|purple|black|pink|aqua|emerald|lava|laser|raywave|stardust|cracked ice|pulsar|cosmic|tri-color|tiger stripe|checkerboard|discs|nebula|finite|numbered))/.test(
      haystack,
    )
  );
}

function normalizeParallelName(parallel = "") {
  const normalized = normalizeText(parallel);
  if (!normalized) return "";
  if (normalized === "base" || normalized === "none") return "";
  return normalized;
}

function parsePositiveInt(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : null;
}

function parsePrintRunFromText(value) {
  const text = String(value || "");
  const fractionRegex = /(\d{1,3})\s*\/\s*(\d{1,4})\b/g;
  const outOfRegex = /(?:^|[^a-z0-9])(\d{1,3})\s*(?:of|out of|\/)\s*(\d{1,4})\b/g;
  let match;
  let bestRun = null;
  while ((match = fractionRegex.exec(text)) !== null) {
    const run = parsePositiveInt(match[2]);
    if (run && (!bestRun || run > bestRun)) {
      bestRun = run;
    }
  }
  while ((match = outOfRegex.exec(text)) !== null) {
    const run = parsePositiveInt(match[2]);
    if (run && (!bestRun || run > bestRun)) {
      bestRun = run;
    }
  }
  if (bestRun) {
    return bestRun;
  }
  const slashOnlyRegex = /\/\s*(\d{1,4})\b/g;
  while ((match = slashOnlyRegex.exec(text)) !== null) {
    const run = parsePositiveInt(match[1]);
    if (run && (!bestRun || run > bestRun)) {
      bestRun = run;
    }
  }
  return bestRun;
}

function isSerializedMetadataTarget(metadata = {}) {
  return Boolean(
    parsePositiveInt(metadata.printRun) ||
      parseSerialRunFromMetadata(metadata.serialNumber) ||
      parseSerialRunFromMetadata(metadata.serializedRunHint),
  );
}

function parseSerialRunFromMetadata(value) {
  if (value == null) return null;
  return parsePrintRunFromText(value);
}

function inferSerialRunFromComp(comp) {
  const fromPrintRun = parsePositiveInt(comp.printRun);
  if (fromPrintRun) return fromPrintRun;
  const fromSerial = parsePrintRunFromText(comp.serialNumber);
  if (fromSerial) return fromSerial;
  const fromTitle = parsePrintRunFromText(comp.title);
  if (fromTitle) return fromTitle;
  const fromKeyword = parsePrintRunFromText(comp.keyword);
  if (fromKeyword) return fromKeyword;
  return null;
}

function serialRunAdjustmentFactor(targetRun, comparableRun) {
  if (!targetRun || !comparableRun) return 1;
  if (targetRun === comparableRun) return 1;
  const ratio = comparableRun / targetRun;
  const raw = Math.pow(ratio, 0.35);
  return Math.min(1.8, Math.max(0.65, raw));
}

function applySerialRunFilterForPricing(comps, metadata = {}) {
  const targetRun =
    parsePositiveInt(metadata.printRun) ||
    parseSerialRunFromMetadata(metadata.serialNumber) ||
    parseSerialRunFromMetadata(metadata.serializedRunHint);

  if (!targetRun) {
    return {
      mode: "disabled_not_serialized",
      exactCount: 0,
      fallbackCount: 0,
      adjustedCount: 0,
      usedCount: comps.length,
      comps,
    };
  }

  const serialComps = comps
    .map((comp) => {
      const run = inferSerialRunFromComp(comp);
      return run ? { comp, run } : null;
    })
    .filter(Boolean);

  if (!serialComps.length) {
    return {
      mode: "no_serial_comps_found",
      exactCount: 0,
      fallbackCount: 0,
      adjustedCount: 0,
      usedCount: comps.length,
      comps,
    };
  }

  const exact = serialComps
    .filter((entry) => entry.run === targetRun)
    .map((entry) => entry.comp);

  if (exact.length) {
    return {
      mode: "exact_serial_run",
      exactCount: exact.length,
      fallbackCount: serialComps.length - exact.length,
      adjustedCount: 0,
      usedCount: exact.length,
      comps: exact,
    };
  }

  const adjusted = serialComps.map((entry) => {
    const factor = serialRunAdjustmentFactor(targetRun, entry.run);
    const adjustedPrice = compPrice(entry.comp) * factor;
    return {
      ...entry.comp,
      serialRun: entry.run,
      serialRunAdjustedPrice: roundMoney(adjustedPrice),
      serialRunAdjustmentFactor: Number(factor.toFixed(4)),
    };
  });

  return {
    mode: "fallback_serialized",
    exactCount: 0,
    fallbackCount: serialComps.length,
    adjustedCount: adjusted.length,
    usedCount: adjusted.length,
    comps: adjusted,
  };
}

function isExactParallelMatch(title, parallel) {
  const haystack = normalizeText(title);
  return Boolean(haystack && parallel && haystack.includes(parallel));
}

function isSimilarParallelMatch(title, parallel) {
  const target = normalizeText(parallel);
  const haystack = normalizeText(title);
  if (!haystack || !target) return false;
  if (!hasParallelSignal(haystack)) return false;
  const targetWords = target.split(" ").filter((word) => word.length >= 3);
  if (!targetWords.length) return false;
  if (targetWords.length === 1) {
    return targetWords.every((word) => haystack.includes(word));
  }
  const matches = targetWords.filter((word) => haystack.includes(word));
  return matches.length >= Math.min(2, targetWords.length);
}

function classifyParallelComps(comps, parallel) {
  const exact = [];
  const similar = [];
  for (const comp of comps) {
    const title = comp.title || "";
    if (isBaseTitle(title)) continue;
    if (!title) continue;
    if (isExactParallelMatch(title, parallel)) {
      exact.push(comp);
      continue;
    }
    if (isSimilarParallelMatch(title, parallel)) {
      similar.push(comp);
    }
  }
  return { exact, similar };
}

function applyParallelFilterForPricing(comps, metadata = {}) {
  const parallel = normalizeParallelName(metadata.parallel);
  // A real, specific parallel name always wins over baseHint — baseHint is
  // meant to catch cards with no confidently-detected parallel at all
  // (normalizeParallelName already returns "" for that case, and for the
  // literal "base"/"none" labels). Disabling filtering just because
  // baseHint is *also* true, even when metadata.parallel is a strong,
  // specific value, defeated the entire filter for a real "UNSTOPPABLE" /8
  // parallel whose baseHint had gone stale (see mergeDetectedMetadata in
  // pipeline.js) — letting an unrelated, differently-named parallel's sold
  // price anchor the recommendation with zero parallel-name filtering.
  if (!parallel) {
    return {
      mode: "disabled",
      exactCount: 0,
      similarCount: 0,
      usedCount: comps.length,
      comps,
    };
  }

  const { exact, similar } = classifyParallelComps(comps, parallel);
  const exactCount = exact.length;
  const similarCount = similar.length;
  if (exact.length) {
    return {
      mode: "exact_parallel",
      exactCount,
      similarCount,
      usedCount: exact.length,
      comps: exact,
    };
  }
  if (similar.length) {
    return {
      mode: "similar_parallel",
      exactCount,
      similarCount,
      usedCount: similar.length,
      comps: similar,
    };
  }

  const nonBase = comps.filter((comp) => !isBaseTitle(comp.title || ""));
  if (nonBase.length !== comps.length) {
    return {
      mode: "parallel_not_found_non_base",
      exactCount,
      similarCount,
      usedCount: nonBase.length,
      comps: nonBase,
    };
  }
  return {
    mode: "parallel_not_found_all",
    exactCount,
    similarCount,
    usedCount: comps.length,
    comps,
  };
}

function trimCompOutliers(comps) {
  if (comps.length < 4) return comps;
  const prices = comps.map(compPrice).filter((value) => value > 0);
  if (prices.length < 4) return comps;
  const q1 = percentile(prices, 0.25);
  const q3 = percentile(prices, 0.75);
  const iqr = q3 - q1;
  const low = q1 - 1.5 * iqr;
  const high = q3 + 1.5 * iqr;
  return comps.filter((comp) => {
    const price = compPrice(comp);
    return price >= low && price <= high;
  });
}

export function calculatePrice({
  soldComps = [],
  activeListings = [],
  strategy = "sold_comps_p25",
  metadata = {},
}) {
  const soldEvidence = soldComps
    .map((comp) => compSnapshot(comp, "sold"))
    .filter((comp) => compPrice(comp) > 0);
  const activeEvidence = activeListings
    .map((listing) => compSnapshot(listing, "active"))
    .filter((listing) => compPrice(listing) > 0);
  const parallelMode = applyParallelFilterForPricing([...soldEvidence], metadata);
  const parallelActiveMode = applyParallelFilterForPricing([...activeEvidence], metadata);
  const serialMode = applySerialRunFilterForPricing(parallelMode.comps, metadata);
  const serialActiveMode = applySerialRunFilterForPricing(parallelActiveMode.comps, metadata);
  const finalSoldEvidence =
    serialMode.mode === "no_serial_comps_found" || serialMode.mode === "disabled_not_serialized"
      ? parallelMode.comps
      : serialMode.comps;
  const finalActiveEvidence =
    serialActiveMode.mode === "no_serial_comps_found" ||
    serialActiveMode.mode === "disabled_not_serialized"
      ? parallelActiveMode.comps
      : serialActiveMode.comps;
  const trimmedSoldEvidence = trimCompOutliers(finalSoldEvidence);
  const soldPrices = trimmedSoldEvidence.map(compPrice).filter((value) => value > 0);
  const activePrices = finalActiveEvidence.map(compPrice).filter((value) => value > 0);
  const trimmed = soldPrices;
  const soldMedian = median(trimmed);
  const soldP25 = percentile(trimmed, 0.25);
  const soldAnchor = strategy === "sold_comps_median" ? soldMedian : soldP25;
  const activeMedian = median(activePrices);
  const activeP25 = percentile(activePrices, 0.25);
  const activeFloor = activePrices.length ? Math.min(...activePrices) : null;
  const serializedTarget = isSerializedMetadataTarget(metadata);

  let recommended = soldAnchor ?? soldMedian ?? activeMedian ?? activeFloor ?? null;
  let confidence = soldPrices.length >= 3 ? "high" : soldPrices.length === 2 ? "medium" : "low";
  let reason = "Insufficient sold comps.";
  let soldWeight = null;
  let activeWeight = null;
  let blendApplied = false;

  if (soldPrices.length >= 3) {
    const hasActiveSignal = activeMedian != null;
    const hotRatio = soldAnchor && activeMedian ? activeMedian / soldAnchor : null;
    const shouldBlend =
      hasActiveSignal && hotRatio != null && hotRatio >= 1.75 && activePrices.length >= 3;
    const baseActiveWeight = 0.05;
    const hotnessBoost = shouldBlend ? Math.min(0.2, (hotRatio - 1.75) * 0.35) : 0;
    const activeWeightPct = shouldBlend ? Math.min(0.25, baseActiveWeight + hotnessBoost) : 0;
    const soldWeightPct = 1 - activeWeightPct;
    const blended =
      shouldBlend && soldAnchor != null
        ? soldAnchor * soldWeightPct + activeMedian * activeWeightPct
        : soldAnchor;

    soldWeight = shouldBlend && soldAnchor != null ? soldWeightPct : null;
    activeWeight = shouldBlend && soldAnchor != null ? activeWeightPct : null;
    blendApplied = Boolean(shouldBlend && soldAnchor != null);
    recommended = blended ?? soldMedian ?? soldP25;
    if (shouldBlend && soldAnchor != null) {
      if (hotRatio > 1.5) {
        reason = `Sold comps lead, but active listings are hot; blending ${Math.round(soldWeightPct * 100)}% sold and ${Math.round(activeWeightPct * 100)}% active median.`;
      } else {
        reason = `Using ${strategy === "sold_comps_median" ? "sold median" : "sold 25th percentile"} with a light active-listing check.`;
      }
    } else {
      reason =
        strategy === "sold_comps_median"
          ? "Using trimmed sold comp median."
          : "Using trimmed sold comp 25th percentile.";
    }
  } else if (
    soldPrices.length > 0 &&
    Boolean(normalizeParallelName(metadata.parallel)) &&
    parallelMode.mode !== "exact_parallel" &&
    parallelMode.mode !== "similar_parallel" &&
    (parallelActiveMode.mode === "exact_parallel" || parallelActiveMode.mode === "similar_parallel") &&
    activeMedian != null
  ) {
    // Sold comps exist, but none of them could be confirmed as this card's
    // specific parallel — while the active listings DID confirm it. A
    // same-print-run (or otherwise coincidentally similar) sold comp for a
    // completely different, unrelated parallel is not comparable just
    // because it cleared the serial-run filter; trust the parallel-
    // confirmed active median over it. Real case: a raw "UNSTOPPABLE" /8
    // card anchored to $206.50 from a PSA-graded "Lucky Envelopes" /8 sold
    // comp — an unrelated parallel that only coincidentally shared the /8
    // print run — while the only parallel-confirmed comps (all active)
    // clustered near $1.
    recommended = activeMedian;
    confidence = "low";
    reason = "No sold comp confirmed this specific parallel; using the active-listing median for confirmed matches instead.";
  } else if (soldPrices.length > 0 && serializedTarget) {
    reason = "Using available sold comps for serialized card pricing.";
    recommended = soldAnchor ?? soldMedian ?? soldP25;
  } else if (soldPrices.length > 0) {
    // 1-2 sold comps — too few for the "high confidence" branch above, but
    // real evidence nonetheless. Previously any card with fewer than 3 sold
    // comps fell straight to the active-listings branch below and threw
    // this away entirely, even when it was an exact parallel match — a
    // single confirmed-parallel sold comp is a far stronger signal than an
    // active-listing pool that couldn't match the parallel at all and fell
    // back to every other parallel/price for that player+set (see
    // "parallel_not_found_all" below), which can badly skew a median.
    const isExactParallelSold = parallelMode.mode === "exact_parallel";
    const activeParallelMatched =
      parallelActiveMode.mode === "exact_parallel" || parallelActiveMode.mode === "similar_parallel";
    const hasReliableActiveSignal = activeMedian != null && activeParallelMatched;

    if (isExactParallelSold && hasReliableActiveSignal && soldAnchor != null) {
      const activeWeightPct = 0.15;
      const soldWeightPct = 1 - activeWeightPct;
      recommended = soldAnchor * soldWeightPct + activeMedian * activeWeightPct;
      soldWeight = soldWeightPct;
      activeWeight = activeWeightPct;
      blendApplied = true;
      reason = `Thin sold comps (${soldPrices.length}) but an exact parallel match; blending ${Math.round(soldWeightPct * 100)}% sold and ${Math.round(activeWeightPct * 100)}% active median.`;
    } else {
      recommended = soldAnchor ?? soldMedian ?? soldP25;
      reason = isExactParallelSold
        ? `Using ${soldPrices.length} exact-parallel sold comp(s) — active listings didn't match this parallel closely enough to blend in.`
        : "Using available sold comps (thin sample, no confirmed parallel match).";
    }
    confidence = "low";
  } else if (activeFloor != null) {
    reason =
      activePrices.length >= 3
        ? "Using active listing median because sold comps are thin."
        : "Using active listing floor because sold comps are thin.";
    confidence = "low";
    recommended = activeMedian ?? activeP25 ?? activeFloor;
  }

  if (recommended == null) {
    recommended = 0;
  }

  return {
    recommendedPrice: roundMoney(recommended),
    soldMedian: soldMedian == null ? null : roundMoney(soldMedian),
    soldP25: soldP25 == null ? null : roundMoney(soldP25),
    activeMedian: activeMedian == null ? null : roundMoney(activeMedian),
    activeP25: activeP25 == null ? null : roundMoney(activeP25),
    activeFloor: activeFloor == null ? null : roundMoney(activeFloor),
    soldCompCount: soldEvidence.length,
    usedSoldCompCount: trimmedSoldEvidence.length,
    activeListingCount: activePrices.length,
    confidence,
    strategy,
    reason,
    trimmedSoldPrices: trimmed.map(roundMoney),
    evidence: {
      sold: trimmedSoldEvidence.slice().sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0)),
      active: activeEvidence.slice().sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0)),
      soldAnchor: soldAnchor == null ? null : roundMoney(soldAnchor),
      soldMedian: soldMedian == null ? null : roundMoney(soldMedian),
      soldP25: soldP25 == null ? null : roundMoney(soldP25),
      activeMedian: activeMedian == null ? null : roundMoney(activeMedian),
      activeP25: activeP25 == null ? null : roundMoney(activeP25),
      activeFloor: activeFloor == null ? null : roundMoney(activeFloor),
      soldWeight: soldWeight == null ? null : Number(soldWeight.toFixed(4)),
      activeWeight: activeWeight == null ? null : Number(activeWeight.toFixed(4)),
      blendApplied,
      soldParallelFilterMode: parallelMode.mode,
      activeParallelFilterMode: parallelActiveMode.mode,
      soldParallelExactCount: parallelMode.exactCount,
      soldParallelSimilarCount: parallelMode.similarCount,
      activeParallelExactCount: parallelActiveMode.exactCount,
      activeParallelSimilarCount: parallelActiveMode.similarCount,
      soldSerialFilterMode: serialMode.mode,
      activeSerialFilterMode: serialActiveMode.mode,
      soldSerialExactCount: serialMode.exactCount,
      soldSerialFallbackCount: serialMode.fallbackCount,
      soldSerialAdjustedCount: serialMode.adjustedCount,
      activeSerialExactCount: serialActiveMode.exactCount,
      activeSerialFallbackCount: serialActiveMode.fallbackCount,
      activeSerialAdjustedCount: serialActiveMode.adjustedCount,
    },
  };
}
