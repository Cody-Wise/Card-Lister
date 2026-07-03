import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../src/lib/load-env.js";
import { getSupabase, hasSupabaseConfig } from "../src/lib/supabase.js";

await loadEnvFile();

// Renames the persisted CardHedge-era field names to provider-neutral names
// on every cardItem/offer, now that CardHedge has been fully removed (see
// the naming note at the top of src/services/apify.js). Deliberately
// bypasses store.js's readState() reconciliation for the same reason as
// scripts/fix-card-0063.mjs: always treats this machine's on-disk
// data/state.json as ground truth, patches it, and force-writes the result
// to both disk and Supabase so both sides end up identical.

const FIELD_RENAMES = {
  cardhedgeMatch: "externalCompMatch",
  cardhedgeMatchWarning: "externalCompMatchWarning",
  cardhedgePricingSummary: "externalPricingSummary",
  cardhedgeLookupAttemptedAt: "externalCompLookupAttemptedAt",
};

function renameFields(record) {
  let changed = false;
  for (const [oldKey, newKey] of Object.entries(FIELD_RENAMES)) {
    if (!Object.prototype.hasOwnProperty.call(record, oldKey)) continue;
    if (!Object.prototype.hasOwnProperty.call(record, newKey)) {
      record[newKey] = record[oldKey];
    }
    delete record[oldKey];
    changed = true;
  }
  return changed;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateFile = path.join(rootDir, "data", "state.json");

const raw = await fs.readFile(stateFile, "utf8");
const state = JSON.parse(raw);

let cardItemsChanged = 0;
let offersChanged = 0;

for (const card of state.cardItems || []) {
  if (renameFields(card)) cardItemsChanged += 1;
}
for (const offer of state.offers || []) {
  if (renameFields(offer)) offersChanged += 1;
}

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
    {
      cardItemsChanged,
      offersChanged,
      cardItemsCount: state.cardItems.length,
      offersCount: state.offers.length,
      supabaseResult,
    },
    null,
    2,
  ),
);
