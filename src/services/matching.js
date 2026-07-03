import { catalog } from "../data/seed.js";
import { normalize } from "../lib/card-query.js";

function scoreMatch(card, metadata) {
  let score = 0;
  if (
    card.playerName &&
    metadata.playerName &&
    normalize(card.playerName) === normalize(metadata.playerName)
  )
    score += 4;
  if (card.year && metadata.year && Number(card.year) === Number(metadata.year)) score += 3;
  if (card.setName && metadata.setName && normalize(card.setName) === normalize(metadata.setName))
    score += 4;
  if (
    card.cardNumber &&
    metadata.cardNumber &&
    normalize(card.cardNumber) === normalize(metadata.cardNumber)
  )
    score += 3;
  if (card.gradedFlag === Boolean(metadata.gradedFlag)) score += 1;
  if (card.grade && metadata.grade && normalize(card.grade) === normalize(metadata.grade))
    score += 3;
  if (Boolean(card.rookieFlag) === Boolean(metadata.rookieFlag)) score += 1;
  if (Boolean(card.autographFlag) === Boolean(metadata.autographFlag)) score += 1;
  if (
    card.variantLabel &&
    metadata.variantLabel &&
    normalize(card.variantLabel) === normalize(metadata.variantLabel)
  )
    score += 2;
  const haystack = normalize(`${metadata.playerName} ${metadata.setName} ${metadata.cardNumber}`);
  for (const alias of card.aliases) {
    if (haystack.includes(normalize(alias))) score += 2;
  }
  if (metadata.rookieFlag && /rookie|rc/i.test(`${card.parallel || ""} ${card.setName || ""}`)) {
    score += 1;
  }
  if (
    metadata.autographFlag &&
    /auto|autograph|signed|signature/i.test(
      `${card.parallel || ""} ${card.setName || ""} ${card.variantLabel || ""}`,
    )
  ) {
    score += 1;
  }
  return score;
}

export function matchCardIdentity(metadata) {
  const ranked = catalog
    .map((card) => ({
      card,
      score: scoreMatch(card, metadata),
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0] || null;
  const confidence = best ? Math.min(0.99, best.score / 15) : 0;

  return {
    canonicalCard: best && best.score >= 6 ? best.card : null,
    confidence,
    alternatives: ranked.slice(0, 3).map((entry) => ({
      card: entry.card,
      score: entry.score,
    })),
  };
}
