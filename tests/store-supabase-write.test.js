import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// writeState() now awaits the Supabase snapshot write instead of firing it
// off in the background (see the "Source of truth" discussion in README —
// local disk is written first, but a write isn't considered durable until
// its Supabase mirror attempt has also resolved, closing the window where a
// lost local disk between a local write and its async Supabase mirror could
// mean that write existed nowhere durable). This file sets fake Supabase env
// vars and mocks global.fetch (which @supabase/supabase-js uses under the
// hood) BEFORE importing anything — Node's test runner isolates each
// *.test.js file into its own process, so this can't leak into other test
// files, but within this file the getSupabase() client singleton must be
// created only after these env vars are set.
process.env.SUPABASE_URL = "https://fake-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key";

const { withState } = await import("../src/lib/store.js");

// withState() genuinely reads/writes the real local data/state.json (only
// the Supabase side is mocked) — back it up and restore it verbatim so this
// suite never leaves stray test counters in real local dev data.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateFilePath = path.join(rootDir, "data", "state.json");
let backedUpState;
let backupExisted = false;

before(async () => {
  try {
    backedUpState = await fsp.readFile(stateFilePath, "utf8");
    backupExisted = true;
  } catch {
    backupExisted = false;
  }
});

after(async () => {
  if (backupExisted) {
    await fsp.writeFile(stateFilePath, backedUpState);
  } else {
    await fsp.rm(stateFilePath, { force: true });
  }
});

function mockFetch(handler) {
  const originalFetch = global.fetch;
  global.fetch = handler;
  return () => {
    global.fetch = originalFetch;
  };
}

test("writeState awaits the Supabase snapshot write before withState resolves", async () => {
  let supabaseCallResolved = false;
  let withStateResolvedBeforeSupabaseCall = null;
  const restore = mockFetch(async (url) => {
    // Only intercept calls aimed at our fake Supabase project; anything else
    // (there shouldn't be any in this test) falls through untouched.
    if (!String(url).startsWith(process.env.SUPABASE_URL)) {
      throw new Error(`Unexpected fetch to ${url} in this test`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    supabaseCallResolved = true;
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve([]),
      text: () => Promise.resolve("[]"),
    };
  });
  try {
    await withState((state) => {
      state.counters = { ...state.counters, __test_marker: (state.counters?.__test_marker || 0) + 1 };
    });
    withStateResolvedBeforeSupabaseCall = !supabaseCallResolved;
    assert.equal(supabaseCallResolved, true, "expected the Supabase write to have resolved by the time withState returned");
    assert.equal(withStateResolvedBeforeSupabaseCall, false);
  } finally {
    restore();
  }
});

test("a Supabase write failure is swallowed — withState still resolves, local write already succeeded", async () => {
  let fetchWasCalled = false;
  const restore = mockFetch(async (url) => {
    if (!String(url).startsWith(process.env.SUPABASE_URL)) {
      throw new Error(`Unexpected fetch to ${url} in this test`);
    }
    fetchWasCalled = true;
    throw new Error("simulated network failure");
  });
  try {
    const result = await withState((state) => {
      state.counters = { ...state.counters, __test_marker_2: 1 };
      return "mutator ran";
    });
    assert.equal(fetchWasCalled, true);
    assert.equal(result, "mutator ran");
  } finally {
    restore();
  }
});
