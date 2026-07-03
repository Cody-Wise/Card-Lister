import test from "node:test";
import assert from "node:assert/strict";
import {
  hasXimilarGradingConfig,
  submitGradingJob,
  pollGradingJob,
  parseGradingResult,
  submitAndPollGrading,
} from "../src/services/ximilar-grading.js";

// The parseGradingResult payload shapes below mirror a real captured job
// response (2026-07-03, job 87eaa5aa-ad41-4675-b783-f1332753244d) with only
// the image/URL/timing noise trimmed out — results live at
// payload.response.records[], one record per submitted image, each with its
// own grades: {final, condition, centering, corners, edges, surface}.

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
        json: async () => ({ status: "DONE", response: { records: [{ grades: { final: 9.5, condition: "Gem Mint" } }] } }),
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

test("parseGradingResult reads results from response.records[] (the real completed-job shape), one record per submitted image", () => {
  // Single-image case (e.g. only a front was submitted) — no min-combining needed.
  const payload = {
    status: "DONE",
    response: {
      records: [
        { grades: { final: 7, condition: "Near Mint", centering: 6, corners: 7.5, edges: 8, surface: 7.5 } },
      ],
    },
  };
  const result = parseGradingResult(payload);
  assert.equal(result.grade, 7);
  assert.equal(result.gradeLabel, "Near Mint");
  assert.equal(result.centering, 6);
  assert.equal(result.corners, 7.5);
  assert.equal(result.edges, 8);
  assert.equal(result.surface, 7.5);
});

test("parseGradingResult combines front+back records by taking the worse (lower) grade per category", () => {
  const payload = {
    status: "DONE",
    response: {
      records: [
        { grades: { final: 7, condition: "Near Mint", centering: 6, corners: 7.5, edges: 8, surface: 7.5 } },
        { grades: { final: 8, condition: "Near Mint", centering: 10, corners: 8, edges: 7.5, surface: 7.5 } },
      ],
    },
  };
  const result = parseGradingResult(payload);
  assert.equal(result.grade, 7);
  assert.equal(result.gradeLabel, "Near Mint");
  assert.equal(result.centering, 6);
  assert.equal(result.corners, 7.5);
  assert.equal(result.edges, 7.5);
  assert.equal(result.surface, 7.5);
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

test("parseGradingResult returns nulls when records exist but carry no grades object", () => {
  const result = parseGradingResult({ response: { records: [{ _status: { code: 200 } }] } });
  assert.equal(result.grade, null);
  assert.equal(result.gradeLabel, null);
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
        json: async () => ({ status: "DONE", response: { records: [{ grades: { final: 7, condition: "Near Mint" } }] } }),
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
