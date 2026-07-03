import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getSupabase,
  camelToSnake,
  snakeToCamel,
  mapKeys,
  hasSupabaseConfig,
} from "./supabase.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = path.join(rootDir, "data");
const imagesDir = path.join(dataDir, "images");
const stateFile = path.join(dataDir, "state.json");
const backupsDir = path.join(dataDir, "backups");
const MAX_BACKUPS = 20;
const PRIMARY_STATE_SNAPSHOT_ID = "primary";
const SUPABASE_IO_TIMEOUT_MS = Math.max(
  500,
  Math.min(30000, Number.parseInt(process.env.SUPABASE_IO_TIMEOUT_MS || "10000", 10) || 10000),
);
const SUPABASE_FULL_SYNC_TIMEOUT_MS = Math.max(
  SUPABASE_IO_TIMEOUT_MS,
  Math.min(120000, Number.parseInt(process.env.SUPABASE_FULL_SYNC_TIMEOUT_MS || "60000", 10) || 60000),
);
const SUPABASE_RELATIONAL_SYNC_ENABLED = process.env.SUPABASE_ENABLE_RELATIONAL_SYNC === "1";

const emptyState = () => ({
  counters: {},
  batches: [],
  cardItems: [],
  cardImages: [],
  cardIdentities: [],
  comps: [],
  offers: [],
  auditEvents: [],
  gradingItems: [],
});

function isPublishedOffer(offer) {
  if (!offer) return false;
  return (
    offer.status === "published" ||
    offer.status === "active" ||
    offer.status === "listed" ||
    Boolean(offer.listingUrl)
  );
}

function normalizeState(state) {
  const offersByCardId = new Map();
  for (const offer of state.offers || []) {
    if (!offer?.cardItemId) continue;
    const bucket = offersByCardId.get(offer.cardItemId) || [];
    bucket.push(offer);
    offersByCardId.set(offer.cardItemId, bucket);
  }

  for (const cardItem of state.cardItems || []) {
    const offers = offersByCardId.get(cardItem?.id) || [];
    const publishedOffer = offers.find(isPublishedOffer) || null;
    const isPublished =
      cardItem?.publishState === "published" ||
      cardItem?.status === "listed" ||
      Boolean(cardItem?.listingUrl) ||
      Boolean(publishedOffer);

    if (!isPublished) continue;

    cardItem.status = "listed";
    cardItem.publishState = "published";
    if (!cardItem.listingId && publishedOffer?.listingId) {
      cardItem.listingId = publishedOffer.listingId;
    }
    if (!cardItem.listingUrl && publishedOffer?.listingUrl) {
      cardItem.listingUrl = publishedOffer.listingUrl;
    }
    if (!cardItem.publishedAt && publishedOffer?.publishedAt) {
      cardItem.publishedAt = publishedOffer.publishedAt;
    }
  }

  return state;
}

function stateHasData(state) {
  return Boolean(
    Object.keys(state?.counters || {}).length ||
    state?.batches?.length ||
    state?.cardItems?.length ||
    state?.cardImages?.length ||
    state?.cardIdentities?.length ||
    state?.comps?.length ||
    state?.offers?.length ||
    state?.auditEvents?.length ||
    state?.gradingItems?.length,
  );
}

function stateFreshnessMs(state = {}) {
  let newest = 0;
  const arrays = [
    state.batches,
    state.cardItems,
    state.cardImages,
    state.cardIdentities,
    state.comps,
    state.offers,
    state.auditEvents,
    state.gradingItems,
  ];
  for (const items of arrays) {
    for (const item of Array.isArray(items) ? items : []) {
      for (const key of ["updatedAt", "createdAt", "externalCompUpdatedAt", "externalCompLookupAttemptedAt", "gradedAt", "transferredAt"]) {
        const time = Date.parse(String(item?.[key] || ""));
        if (Number.isFinite(time) && time > newest) newest = time;
      }
    }
  }
  return newest;
}

function shouldPreferLocalState(local, remote) {
  if (!stateHasData(local)) return false;
  if (!stateHasData(remote)) return true;
  const localFreshness = stateFreshnessMs(local);
  const remoteFreshness = stateFreshnessMs(remote);
  if (localFreshness && remoteFreshness && localFreshness > remoteFreshness + 1000) return true;
  return (local.auditEvents || []).length > (remote.auditEvents || []).length;
}

let queue = Promise.resolve();
let pendingSupabaseState = null;
let supabaseWritePromise = null;
// Set once this single-instance process has reconciled local vs. Supabase
// state on its first read. After that, the local file (kept current by every
// writeState() call) is authoritative for the rest of the process's life, so
// we skip re-fetching the multi-MB state_snapshots blob from Supabase on
// every subsequent read — that was the source of near-continuous Supabase/
// Kong load, since every withState()/withStateReadOnly() call used to hit it.
let hasHydratedFromSupabase = false;

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function scheduleSupabaseSnapshotWrite(state, label = "Supabase snapshot write") {
  if (!hasSupabaseConfig()) return;
  const snapshot = cloneState(state);
  void withTimeout(writeStateSnapshotToSupabase(snapshot), SUPABASE_IO_TIMEOUT_MS, label)
    .catch((error) => {
      console.error(`${label} failed:`, error.message);
    });
}

function scheduleSupabaseWrite(state, label = "Supabase write") {
  if (!hasSupabaseConfig()) return;
  pendingSupabaseState = cloneState(state);
  if (supabaseWritePromise) return;
  supabaseWritePromise = (async () => {
    while (pendingSupabaseState) {
      const snapshot = pendingSupabaseState;
      pendingSupabaseState = null;
      try {
        await withTimeout(writeStateSnapshotToSupabase(snapshot), SUPABASE_IO_TIMEOUT_MS, "Supabase snapshot write");
      } catch (error) {
        console.error("Supabase snapshot write failed:", error.message);
      }
      if (SUPABASE_RELATIONAL_SYNC_ENABLED) {
        try {
          await withTimeout(writeStateTablesToSupabase(snapshot), SUPABASE_FULL_SYNC_TIMEOUT_MS, "Supabase relational sync");
        } catch (error) {
          console.error("Supabase relational sync failed:", error.message);
        }
      }
    }
  })().finally(() => {
    supabaseWritePromise = null;
    if (pendingSupabaseState) {
      scheduleSupabaseWrite(pendingSupabaseState, label);
    }
  });
}

async function ensureDirs() {
  await fs.mkdir(imagesDir, { recursive: true });
}

async function readStateJson() {
  await ensureDirs();
  try {
    const raw = await fs.readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw);
    const state = { ...emptyState(), ...parsed };
    const before = JSON.stringify(state);
    normalizeState(state);
    if (JSON.stringify(state) !== before) {
      await writeStateJson(state);
    }
    return state;
  } catch (error) {
    if (error.code === "ENOENT") {
      const state = emptyState();
      await writeStateJson(state);
      return state;
    }
    throw error;
  }
}

async function pruneBackups() {
  try {
    const files = (await fs.readdir(backupsDir))
      .filter((f) => f.startsWith("state-") && f.endsWith(".json"))
      .sort()
      .reverse();
    if (files.length > MAX_BACKUPS) {
      for (const f of files.slice(MAX_BACKUPS)) {
        await fs.unlink(path.join(backupsDir, f)).catch(() => {});
      }
    }
  } catch {}
}

async function writeStateJson(state) {
  await ensureDirs();
  try {
    const existing = await fs.readFile(stateFile, "utf8");
    const backupName = `state-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    await fs.mkdir(backupsDir, { recursive: true });
    await fs.writeFile(path.join(backupsDir, backupName), existing);
    await pruneBackups();
  } catch (err) {
    if (err.code !== "ENOENT") console.error("backup error:", err.message);
  }
  const tempFile = `${stateFile}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(state, null, 2));
  await fs.rename(tempFile, stateFile);
}

async function readCounters() {
  const supabase = getSupabase();
  const { data } = await supabase.from("counters").select("*");
  const counters = {};
  if (data) {
    for (const row of data) {
      counters[row.prefix] = row.value;
    }
  }
  return counters;
}

async function writeCounters(counters) {
  const supabase = getSupabase();
  for (const [prefix, value] of Object.entries(counters)) {
    await supabase.from("counters").upsert({ prefix, value }, { onConflict: "prefix" });
  }
}

async function readAllFromTable(table) {
  const supabase = getSupabase();
  const { data } = await supabase.from(table).select("*");
  return data || [];
}

async function readStateSnapshotFromSupabase() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("state_snapshots")
    .select("snapshot")
    .eq("id", PRIMARY_STATE_SNAPSHOT_ID)
    .maybeSingle();
  if (error) {
    const message = String(error?.message || "");
    if (message.includes("state_snapshots") || message.includes("Could not find")) {
      return null;
    }
    throw error;
  }
  if (!data?.snapshot || typeof data.snapshot !== "object") return null;
  const state = { ...emptyState(), ...data.snapshot };
  normalizeState(state);
  return state;
}

async function readState() {
  const local = await readStateJson();
  if (!hasSupabaseConfig() || process.env.READ_STORE === "local") {
    return local;
  }
  if (hasHydratedFromSupabase) {
    return local;
  }
  hasHydratedFromSupabase = true;
  try {
    const snapshot = await withTimeout(
      readStateSnapshotFromSupabase(),
      SUPABASE_IO_TIMEOUT_MS,
      "Supabase snapshot read",
    );
    if (snapshot && stateHasData(snapshot)) {
      if (shouldPreferLocalState(local, snapshot)) {
        scheduleSupabaseWrite(local, "Supabase catch-up write");
        return local;
      }
      return snapshot;
    }
    const results = await withTimeout(
      Promise.all([
        readCounters(),
        readAllFromTable("batches"),
        readAllFromTable("card_items"),
        readAllFromTable("card_images"),
        readAllFromTable("card_identities"),
        readAllFromTable("comps"),
        readAllFromTable("offers"),
        readAllFromTable("audit_events"),
      ]),
      SUPABASE_IO_TIMEOUT_MS,
      "Supabase state read",
    );
    const remote = {
      counters: results[0],
      batches: results[1].map((r) => mapKeys(r, snakeToCamel)),
      cardItems: results[2].map((r) => mapKeys(r, snakeToCamel)),
      cardImages: results[3].map((r) => mapKeys(r, snakeToCamel)),
      cardIdentities: results[4].map((r) => mapKeys(r, snakeToCamel)),
      comps: results[5].map((r) => mapKeys(r, snakeToCamel)),
      offers: results[6].map((r) => mapKeys(r, snakeToCamel)),
      auditEvents: results[7].map((r) => mapKeys(r, snakeToCamel)),
    };
    normalizeState(remote);
    if (remote.cardItems.length > 0 || remote.offers.length > 0 || remote.batches.length > 0) {
      if (shouldPreferLocalState(local, remote)) {
        scheduleSupabaseWrite(local, "Supabase catch-up write");
        return local;
      }
      scheduleSupabaseSnapshotWrite(remote);
      return remote;
    }
    if (local.cardItems.length > 0 || local.offers.length > 0 || local.batches.length > 0) {
      scheduleSupabaseWrite(local, "Supabase bootstrap write");
      return local;
    }
    return remote;
  } catch {
    return local;
  }
}

async function batchUpsert(supabase, table, items, allowedColumns) {
  if (!items.length) return;
  const snake = items.map((r) => mapKeys(r, camelToSnake));
  const rows = allowedColumns
    ? snake.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => allowedColumns.has(k))))
    : snake;
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (row[key] === "" && isNumericColumn(key)) row[key] = null;
    }
  }
  const { error } = await supabase.from(table).upsert(rows, { onConflict: "id", ignoreDuplicates: false });
  if (error) {
    const match = error.message.match(/Could not find the '(\w+)' column/);
    if (match && allowedColumns) {
      allowedColumns.delete(match[1]);
      return batchUpsert(supabase, table, items, allowedColumns);
    }
    const notNullMatch = error.message.match(/null value in column "(\w+)" of relation "(\w+)" violates not-null constraint/);
    if (notNullMatch && allowedColumns) {
      const col = notNullMatch[1];
      allowedColumns.delete(col);
      return batchUpsert(supabase, table, items, allowedColumns);
    }
    throw error;
  }
}

function isNumericColumn(column) {
  return /^(year|print_run|serial_number|card_number|candidate_year|confidence_score|recommended_price|price|quantity|count|length|width|height|weight|size|number|id|_id|_count|_number|_score|_price|_run|_year|_number)$/.test(column)
    || /_id$/.test(column)
    || /_count$/.test(column)
    || /_number$/.test(column)
    || /_score$/.test(column)
    || /_price$/.test(column)
    || /_run$/.test(column)
    || /_year$/.test(column);
}

async function writeStateSnapshotToSupabase(state) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("state_snapshots")
    .upsert({
      id: PRIMARY_STATE_SNAPSHOT_ID,
      snapshot: state,
      source: "app",
      updated_at: new Date().toISOString(),
    }, { onConflict: "id" });
  if (error) {
    const message = String(error?.message || "");
    if (message.includes("state_snapshots") || message.includes("Could not find")) {
      return;
    }
    throw error;
  }
}

async function writeStateTablesToSupabase(state) {
  const supabase = getSupabase();
  // gradingItems intentionally isn't in this relational-sync list yet — it
  // still rides along in the whole-state Supabase snapshot (state_snapshots),
  // which is the only mirror path active while SUPABASE_ENABLE_RELATIONAL_SYNC
  // is off (the default). Add a grading_items table + entry here before ever
  // turning that env var on, or grading data will silently drop out of the
  // relational mirror.
  const insertOrder = ["batches", "card_items", "card_identities", "card_images", "comps", "offers", "audit_events"];
  const localKey = (table) =>
    ({ card_items: "cardItems", card_images: "cardImages", card_identities: "cardIdentities", audit_events: "auditEvents" })[table] || table;
  for (const table of insertOrder) {
    const items = state[localKey(table)] || [];
    const ids = items.map((r) => r.id).filter(Boolean).map(String);
    if (ids.length) {
      const idsStr = "(" + ids.map((id) => `"${id}"`).join(",") + ")";
      await supabase.from(table).delete().not("id", "in", idsStr);
    } else {
      await supabase.from(table).delete().neq("id", "__SUPABASE_SYNC__");
    }
    if (items.length) {
      const allKeys = new Set(items.flatMap((r) => Object.keys(r).map((k) => k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()))));
      await batchUpsert(supabase, table, items, allKeys);
    }
  }
  await writeCounters(state.counters);
}

async function writeState(state) {
  normalizeState(state);
  await writeStateJson(state);
  // Synchronous (awaited), not fire-and-forget: withState()'s queue already
  // serializes every state-mutating call, so this doesn't introduce new
  // concurrency — it just means a write isn't considered "done" until it's
  // durably in Supabase too, closing the window where a lost local disk
  // between a local write and its (previously async) Supabase mirror could
  // mean that write existed nowhere durable. A Supabase failure/timeout here
  // is logged, not thrown — the local write already succeeded and callers
  // shouldn't see a spurious failure for a durability-layer hiccup.
  if (hasSupabaseConfig()) {
    const snapshot = cloneState(state);
    try {
      await withTimeout(
        writeStateSnapshotToSupabase(snapshot),
        SUPABASE_IO_TIMEOUT_MS,
        "Supabase snapshot write",
      );
    } catch (error) {
      console.error("Supabase snapshot write failed:", error.message);
    }
    if (SUPABASE_RELATIONAL_SYNC_ENABLED) {
      // The relational tables are a supplementary denormalized view, not the
      // primary snapshot — keep this one fire-and-forget rather than adding
      // its (typically much larger) per-table diff/upsert cost to every
      // write's latency.
      void withTimeout(
        writeStateTablesToSupabase(snapshot),
        SUPABASE_FULL_SYNC_TIMEOUT_MS,
        "Supabase relational sync",
      ).catch((error) => console.error("Supabase relational sync failed:", error.message));
    }
  }
}

export async function withState(mutator, { readOnly = false } = {}) {
  const task = queue.then(async () => {
    const state = await readState();
    const before = readOnly ? null : JSON.stringify(state);
    const result = await mutator(state);
    if (!readOnly && JSON.stringify(state) !== before) {
      await writeState(state);
    }
    return result;
  });
  queue = task.catch(() => undefined);
  return task;
}

export async function withStateReadOnly(mutator) {
  return withState(mutator, { readOnly: true });
}

export async function getState() {
  return readState();
}

export function createId(state, prefix) {
  const next = (state.counters[prefix] ?? 0) + 1;
  state.counters[prefix] = next;
  return `${prefix}_${String(next).padStart(4, "0")}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function createAuditEvent(state, entityType, entityId, action, payload) {
  const id = createId(state, "evt");
  state.auditEvents.push({
    id,
    entityType,
    entityId,
    action,
    payload,
    createdAt: nowIso(),
  });
}

export async function exportState() {
  return readState();
}

export async function importState(data) {
  const merged = { ...emptyState(), ...data };
  await writeState(merged);
}

export async function syncLocalToSupabase() {
  if (!hasSupabaseConfig()) return { synced: false, reason: "no supabase config" };
  try {
    const local = await readStateJson();
    const localCardCount = local.cardItems.length;
    if (localCardCount === 0) return { synced: false, reason: "no local data" };
    const supabase = getSupabase();
    const { data: remoteCards } = await supabase.from("card_items").select("id").limit(1);
    if (remoteCards && remoteCards.length > 0) {
      return { synced: false, reason: "supabase already has card items" };
    }
    const insertOrder = ["batches", "card_items", "card_identities", "card_images", "comps", "offers", "audit_events"];
    const localKey = (table) =>
      ({ card_items: "cardItems", card_images: "cardImages", card_identities: "cardIdentities", audit_events: "auditEvents" })[table] || table;
    for (const table of insertOrder) {
      const items = local[localKey(table)] || [];
      if (!items.length) continue;
      const allKeys = new Set(items.flatMap((r) => Object.keys(r).map((k) => k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()))));
      await batchUpsert(supabase, table, items, allKeys);
    }
    await writeCounters(local.counters);
    await writeStateSnapshotToSupabase(local);
    return { synced: true, cardCount: localCardCount };
  } catch (error) {
    return { synced: false, reason: error.message };
  }
}
