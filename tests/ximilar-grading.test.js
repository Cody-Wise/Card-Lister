import test from "node:test";
import assert from "node:assert/strict";
import {
  hasXimilarGradingConfig,
  submitGradingJob,
  pollGradingJob,
  parseGradingResult,
  submitAndPollGrading,
} from "../src/services/ximilar-grading.js";

// NOTE: the response shapes mocked below are fabricated from Ximilar's
// card-grader docs (https://docs.ximilar.com/collectibles/card-grading), not
// a captured real response — unlike sport_id/tcg_id, this integration has not
// been live-tested against Ximilar's real API yet. Treat the first real
// submission as a smoke test before trusting this in production.

function withEnv(overrides, fn) {
  const original = {};
  for (const key of Object.keys(overrides)) original[key] = process.env[key];
  Object.assign(process.env, overrides);
  return Promise.resolve(fn()).finally(() => {
    for (const key of Object.keys(overrides)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
}

function mockFetch(handler) {
  const originalFetch = global.fetch;
  global.fetch = handler;
  return () => {
    global.fetch = originalFetch;
  };
}

test("hasXimilarGradingConfig reflects XIMILAR_API_TOKEN", async () => {
  await withEnv({ XIMILAR_API_TOKEN: "" }, () => {
    delete process.env.XIMILAR_API_TOKEN;
    assert.equal(hasXimilarGradingConfig(), false);
  });
  await withEnv({ XIMILAR_API_TOKEN: "tok_test" }, () => {
    assert.equal(hasXimilarGradingConfig(), true);
  });
});

test("submitGradingJob posts to the documented endpoint with a Token auth header and both images as records", async () => {
  await withEnv({ XIMILAR_API_TOKEN: "tok_test" }, async () => {
    let requestedUrl = null;
    let requestedInit = null;
    const restore = mockFetch(async (url, init) => {
      requestedUrl = url;
      requestedInit = init;
      return { ok: true, status: 200, json: async () => ({ id: "job_123", status: "QUEUED" }) };
    });
    try {
      const result = await submitGradingJob({ frontBase64: "front64", backBase64: "back64" });
      assert.equal(result.jobId, "job_123");
      assert.equal(requestedUrl, "https://api.ximilar.com/account/v2/request/");
      assert.equal(requestedInit.method, "POST");
      assert.equal(requestedInit.headers.Authorization, "Token tok_test");
      const body = JSON.parse(requestedInit.body);
      assert.equal(body.type, "card-grader");
      assert.equal(body.endpoint, "grade");
      assert.deepEqual(body.records, [{ _base64: "front64" }, { _base64: "back64" }]);
    } finally {
      restore();
    }
  });
});

test("submitGradingJob throws a clear error when Ximilar returns a non-ok response", async () => {
  await withEnv({ XIMILAR_API_TOKEN: "tok_test" }, async () => {
    const restore = mockFetch(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ detail: "Invalid token" }),
    }));
    try {
      await assert.rejects(
        () => submitGradingJob({ frontBase64: "front64" }),
        /Ximilar card-grader submit failed \(401\): Invalid token/,
      );
    } finally {
      restore();
    }
  });
});

test("pollGradingJob polls until DONE and returns the final payload", async () => {
  await withEnv({ XIMILAR_API_TOKEN: "tok_test" }, async () => {
    let callCount = 0;
    const restore = mockFetch(async () => {
      callCount += 1;
      if (callCount < 3) {
        return { ok: true, status: 200, json: async () => ({ status: "IN_PROGRESS" }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "DONE", records: [{ grade: { grade: 9.5, label: "Gem Mint" } }] }),
      };
    });
    try {
      const payload = await pollGradingJob("job_123", { pollIntervalMs: 1, timeoutMs: 5000 });
      assert.equal(callCount, 3);
      assert.equal(payload.status, "DONE");
    } finally {
      restore();
    }
  });
});

test("pollGradingJob throws a distinguishable error when Ximilar reports FAILED", async () => {
  await withEnv({ XIMILAR_API_TOKEN: "tok_test" }, async () => {
    const restore = mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "FAILED", error: "image unreadable" }),
    }));
    try {
      await assert.rejects(
        () => pollGradingJob("job_123", { pollIntervalMs: 1, timeoutMs: 5000 }),
        /Ximilar card-grader job failed: image unreadable/,
      );
    } finally {
      restore();
    }
  });
});

test("pollGradingJob throws a timeout error distinct from a FAILED status when the job never finishes", async () => {
  await withEnv({ XIMILAR_API_TOKEN: "tok_test" }, async () => {
    const restore = mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "IN_PROGRESS" }),
    }));
    try {
      await assert.rejects(
        () => pollGradingJob("job_123", { pollIntervalMs: 1, timeoutMs: 5 }),
        /timed out after 5ms/,
      );
    } finally {
      restore();
    }
  });
});

test("parseGradingResult defensively extracts grade/condition fields from a records[0].grade/condition shape", () => {
  const payload = {
    records: [
      {
        grade: { grade: 9.5, label: "Gem Mint" },
        condition: { centering: 9, corners: 9.5, edges: 9, surface: 10 },
      },
    ],
  };
  const result = parseGradingResult(payload);
  assert.equal(result.grade, 9.5);
  assert.equal(result.gradeLabel, "Gem Mint");
  assert.equal(result.centering, 9);
  assert.equal(result.corners, 9.5);
  assert.equal(result.edges, 9);
  assert.equal(result.surface, 10);
});

test("parseGradingResult falls back to flat top-level fields when there's no nested grade/condition object", () => {
  const payload = { grade: 8, label: "Near Mint-Mint", centering: 8, corners: 8, edges: 7, surface: 9 };
  const result = parseGradingResult(payload);
  assert.equal(result.grade, 8);
  assert.equal(result.gradeLabel, "Near Mint-Mint");
  assert.equal(result.surface, 9);
});

test("parseGradingResult returns nulls instead of throwing on a completely unrecognized shape", () => {
  const result = parseGradingResult({ unexpected: "shape" });
  assert.equal(result.grade, null);
  assert.equal(result.gradeLabel, null);
  assert.equal(result.centering, null);
  assert.equal(result.corners, null);
  assert.equal(result.edges, null);
  assert.equal(result.surface, null);
});

test("submitAndPollGrading combines submit + poll + parse into one call", async () => {
  await withEnv({ XIMILAR_API_TOKEN: "tok_test" }, async () => {
    let submitted = false;
    const restore = mockFetch(async (url, init) => {
      if (init?.method === "POST") {
        submitted = true;
        return { ok: true, status: 200, json: async () => ({ id: "job_456" }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "DONE", records: [{ grade: { grade: 7, label: "Near Mint" } }] }),
      };
    });
    try {
      const result = await submitAndPollGrading(
        { frontBase64: "front64", backBase64: "back64" },
        { pollIntervalMs: 1, timeoutMs: 5000 },
      );
      assert.equal(submitted, true);
      assert.equal(result.jobId, "job_456");
      assert.equal(result.grade, 7);
      assert.equal(result.gradeLabel, "Near Mint");
    } finally {
      restore();
    }
  });
});
