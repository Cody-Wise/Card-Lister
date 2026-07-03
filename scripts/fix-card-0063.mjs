import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../src/lib/load-env.js";
import { getSupabase, hasSupabaseConfig } from "../src/lib/supabase.js";

await loadEnvFile();

// Deterministic, direct fix — deliberately bypasses store.js's readState()
// reconciliation (local vs. Supabase freshness comparison) because that
// comparison uses audit-event *count* as a tiebreaker, which a stray
// READ_STORE=local test run against a dev copy pointed at the same shared
// Supabase project perturbed. This script always treats THIS machine's
// on-disk data/state.json as ground truth, patches it, and force-writes the
// result to both disk and Supabase so both sides end up identical again.

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateFile = path.join(rootDir, "data", "state.json");

const raw = await fs.readFile(stateFile, "utf8");
const state = JSON.parse(raw);
const card = state.cardItems.find((c) => c.id === "card_0063");
if (!card) {
  console.log(JSON.stringify({ found: false }));
  process.exit(0);
}

const before = {
  candidatePlayer: card.candidatePlayer,
  candidateSport: card.candidateSport,
  candidateSetName: card.candidateSetName,
  candidateCardNumber: card.candidateCardNumber,
  candidateParallel: card.candidateParallel,
  canonicalCardId: card.canonicalCardId,
  apifyLookupKey: card.apifyLookupKey,
  ocrNotes: card.ocrNotes,
  apifyError: card.apifyError,
};

card.candidatePlayer = "Jalen Green";
card.candidateSport = "Basketball";
card.candidateSetName = "Panini Select";
card.candidateCardNumber = "42";
card.candidateParallel = "Concourse Prizm";
card.canonicalCardId = null;
card.apifyLookupKey = null;
card.ocrNotes =
  "Corrected: original heuristic seed-catalog match (cat_corbin_carroll_2023_topps_chrome_95_raw) was wrong; real card is Jalen Green 2023-24 Panini Select Concourse Prizm #42, matching ebayTitle/ebaySpecifics.";
delete card.apifyError;

await fs.writeFile(stateFile, JSON.stringify(state, null, 2));

let supabaseResult = "skipped (no Supabase config)";
if (hasSupabaseConfig()) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("state_snapshots")
    .upsert(
      { id: "primary", snapshot: state, source: "app", updated_at: new Date().toISOString() },
      { onConflict: "id" },
    );
  supabaseResult = error ? `error: ${error.message}` : "ok";
}

console.log(
  JSON.stringify(
    { found: true, before, supabaseResult, cardItemsCount: state.cardItems.length, auditEventsCount: state.auditEvents.length },
    null,
    2,
  ),
);
