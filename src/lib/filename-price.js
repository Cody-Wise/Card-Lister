// Parses a human-supplied price out of a scan filename.
//
// Workflow this supports (added 2026-07-26): cards are scanned with eBay's
// own card scanner inside the seller account, and whoever scans them types
// the price they judged into the filename — "LebronJames$7-01.jpg" means a
// $7 read on that card. That's a HUMAN price check, which is materially
// more trustworthy than anything the app derives right now: sold comps went
// behind eBay's sign-in wall (see active-listing-pricing.js), so the app's
// own pricing is currently inferred from other sellers' ASKS.
//
// The trailing "-01"/"-02" is a scan sequence number, not a price, and must
// never be read as one. Likewise a bare number with no "$" is ambiguous
// (card numbers, years, serials all look like that), so a price is only
// recognized when explicitly marked with "$".
// The comma-grouped alternative comes first and REQUIRES at least one comma
// group; the plain alternative then takes unlimited digits. Getting this
// wrong is subtle and dangerous: an earlier version used
// `\d{1,3}(?:,\d{3})*`, which capped the pre-decimal part at three digits,
// so "$1200.99" silently parsed as 120 and "$999999999" as 999 — the latter
// sneaking in under the sanity cap below as a plausible-looking price.
const PRICE_PATTERN = /\$\s*(\d+(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/;

// Upper sanity bound. A filename price beyond this is far more likely a
// typo (a missing decimal, or a scanner id that happens to follow a "$")
// than a real card price — and a bad manual anchor is worse than none, since
// the whole point of this field is that it's the trusted number.
const MAX_REASONABLE_PRICE = 100000;

// Extracts the price from a single filename. Returns null when there's no
// explicit "$" amount, or when the amount doesn't survive sanity checks.
export function parsePriceFromFileName(fileName) {
  const raw = String(fileName || "");
  if (!raw) return null;
  // Strip the extension so something like "card$5.jpg" can't have its
  // extension dot confused with a decimal point.
  const withoutExtension = raw.replace(/\.[a-z0-9]{1,5}$/i, "");
  const match = PRICE_PATTERN.exec(withoutExtension);
  if (!match) return null;
  const value = Number(match[1].replaceAll(",", ""));
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value > MAX_REASONABLE_PRICE) return null;
  return Math.round(value * 100) / 100;
}

// Resolves the manual price for a card from its available filenames. The
// front scan is the primary source; the back is a fallback for when only
// the back got annotated. When both carry a price and they DISAGREE, the
// disagreement is reported rather than silently picking one — a mismatch
// means someone mistyped, and quietly trusting either number would defeat
// the purpose of a human check.
export function resolveManualPriceFromFileNames(frontFileName, backFileName) {
  const front = parsePriceFromFileName(frontFileName);
  const back = parsePriceFromFileName(backFileName);

  if (front != null && back != null && front !== back) {
    return {
      price: front, // front wins, but the conflict is surfaced
      source: "front",
      conflict: { front, back },
      note: `Filename price conflict: front says $${front}, back says $${back} — using the front scan`,
    };
  }
  if (front != null) return { price: front, source: "front", conflict: null, note: null };
  if (back != null) return { price: back, source: "back", conflict: null, note: null };
  return { price: null, source: null, conflict: null, note: null };
}
