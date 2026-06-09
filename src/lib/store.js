import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = path.join(rootDir, "data");
const imagesDir = path.join(dataDir, "images");
const stateFile = path.join(dataDir, "state.json");

const emptyState = () => ({
  counters: {},
  batches: [],
  cardItems: [],
  cardImages: [],
  cardIdentities: [],
  comps: [],
  offers: [],
  auditEvents: []
});

let queue = Promise.resolve();

async function ensureDirs() {
  await fs.mkdir(imagesDir, { recursive: true });
}

async function readState() {
  await ensureDirs();
  try {
    const raw = await fs.readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw);
    return { ...emptyState(), ...parsed };
  } catch (error) {
    if (error.code === "ENOENT") {
      const state = emptyState();
      await writeState(state);
      return state;
    }
    throw error;
  }
}

async function writeState(state) {
  await ensureDirs();
  const tempFile = `${stateFile}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(state, null, 2));
  await fs.rename(tempFile, stateFile);
}

export async function withState(mutator) {
  queue = queue.then(async () => {
    const state = await readState();
    const result = await mutator(state);
    await writeState(state);
    return result;
  });
  return queue;
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
    createdAt: nowIso()
  });
}

