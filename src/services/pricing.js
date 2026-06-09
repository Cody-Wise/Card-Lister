function sortNumbers(values) {
  return [...values].sort((a, b) => a - b);
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
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentileValue)));
  return sorted[index];
}

function trimOutliers(values) {
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
  return Number(comp.salePrice ?? comp.sale_price ?? comp.totalPrice ?? comp.total_price ?? comp.price ?? 0);
}

function compSnapshot(comp, source) {
  return {
    source: comp.source || source || null,
    listingId: comp.listingId || null,
    title: comp.title || null,
    conditionLabel: comp.conditionLabel || null,
    salePrice: comp.salePrice ?? comp.sale_price ?? null,
    shippingPrice: comp.shippingPrice ?? null,
    totalPrice: comp.totalPrice ?? comp.total_price ?? comp.price ?? null,
    soldAt: comp.soldAt || null,
    url: comp.url || null,
    matchScore: comp.matchScore ?? null,
    isBestOfferAccepted: Boolean(comp.isBestOfferAccepted),
    listingType: comp.listingType || null,
    sellerUsername: comp.sellerUsername || null
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

export function calculatePrice({ soldComps = [], activeListings = [], strategy = "sold_comps_p25" }) {
  const soldEvidence = soldComps.map((comp) => compSnapshot(comp, "sold")).filter((comp) => compPrice(comp) > 0);
  const activeEvidence = activeListings.map((listing) => compSnapshot(listing, "active")).filter((listing) => compPrice(listing) > 0);
  const trimmedSoldEvidence = trimCompOutliers(soldEvidence);
  const soldPrices = trimmedSoldEvidence.map(compPrice).filter((value) => value > 0);
  const activePrices = activeEvidence.map(compPrice).filter((value) => value > 0);
  const trimmed = soldPrices;
  const soldMedian = median(trimmed);
  const soldP25 = percentile(trimmed, 0.25);
  const soldAnchor = strategy === "sold_comps_median" ? soldMedian : soldP25;
  const activeMedian = median(activePrices);
  const activeP25 = percentile(activePrices, 0.25);
  const activeFloor = activePrices.length ? Math.min(...activePrices) : null;

  let recommended = soldAnchor ?? soldMedian ?? activeMedian ?? activeFloor ?? null;
  let confidence = soldPrices.length >= 3 ? "high" : soldPrices.length === 2 ? "medium" : "low";
  let reason = "Insufficient sold comps.";
  let soldWeight = null;
  let activeWeight = null;
  let blendApplied = false;

  if (soldPrices.length >= 3) {
    const hasActiveSignal = activeMedian != null;
    const hotRatio = soldAnchor && activeMedian ? activeMedian / soldAnchor : null;
    const shouldBlend = hasActiveSignal && hotRatio != null && hotRatio >= 1.75 && activePrices.length >= 3;
    const baseActiveWeight = 0.05;
    const hotnessBoost = shouldBlend ? Math.min(0.2, (hotRatio - 1.75) * 0.35) : 0;
    const activeWeightPct = shouldBlend ? Math.min(0.25, baseActiveWeight + hotnessBoost) : 0;
    const soldWeightPct = 1 - activeWeightPct;
    const blended = shouldBlend && soldAnchor != null
      ? (soldAnchor * soldWeightPct) + (activeMedian * activeWeightPct)
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
      reason = strategy === "sold_comps_median"
        ? "Using trimmed sold comp median."
        : "Using trimmed sold comp 25th percentile.";
    }
  } else if (activeFloor != null) {
    reason = activePrices.length >= 3
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
      sold: trimmedSoldEvidence.slice().sort((a, b) => compPrice(a) - compPrice(b)),
      active: activeEvidence.slice().sort((a, b) => compPrice(a) - compPrice(b)),
      soldAnchor: soldAnchor == null ? null : roundMoney(soldAnchor),
      soldMedian: soldMedian == null ? null : roundMoney(soldMedian),
      soldP25: soldP25 == null ? null : roundMoney(soldP25),
      activeMedian: activeMedian == null ? null : roundMoney(activeMedian),
      activeP25: activeP25 == null ? null : roundMoney(activeP25),
      activeFloor: activeFloor == null ? null : roundMoney(activeFloor),
      soldWeight: soldWeight == null ? null : Number(soldWeight.toFixed(4)),
      activeWeight: activeWeight == null ? null : Number(activeWeight.toFixed(4)),
      blendApplied
    }
  };
}
