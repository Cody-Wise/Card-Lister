import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { extractCardMetadata } from "../src/services/ocr.js";

test("falls back to heuristic metadata extraction", async () => {
  const result = await extractCardMetadata({
    frontFileName: "2023 Topps Chrome Corbin Carroll 95.jpg",
    backFileName: "corbin-carroll-back.jpg"
  });

  assert.equal(result.playerName, "Corbin Carroll");
  assert.equal(result.year, 2023);
  assert.equal(result.cardNumber, "95");
  assert.ok(result.confidence > 0);
});

test("extracts serial numbers from heuristic metadata", async () => {
  const result = await extractCardMetadata({
    frontText: "Matas Buzelis Select RC",
    backText: "Limited edition numbered 66/75 on back."
  });

  assert.equal(result.serialNumber, "66/75");
  assert.equal(result.printRun, 75);
});

test("detects rookie variants from heuristic metadata", async () => {
  const result = await extractCardMetadata({
    frontText: "Rated Rookie Jalen Brunson",
    backText: "2018-19 Panini Donruss Optic Basketball #179"
  });

  assert.equal(result.rookieFlag, true);
  assert.equal(result.variantLabel, "Rated Rookie");
});

test("keeps manual serial hints in heuristic metadata", async () => {
  const result = await extractCardMetadata({
    frontText: "Islam Makhachev",
    backText: "Topps UFC TTC-19",
    backFileName: "002-150.jpg"
  });

  assert.equal(result.serialNumber, "002/150");
  assert.equal(result.printRun, 150);
});

test("detects autograph hints from heuristic metadata", async () => {
  const result = await extractCardMetadata({
    frontText: "Signature Series Autograph Auto",
    backText: "2024 Panini Contenders Football #12"
  });

  assert.equal(result.autographFlag, true);
});

test("keeps partial OpenAI vision results when one side fails", async (t) => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ocr-vision-"));
  const frontImagePath = path.join(tempDir, `${randomUUID()}-front.jpg`);
  const backImagePath = path.join(tempDir, `${randomUUID()}-back.jpg`);

  await fs.writeFile(frontImagePath, "front");
  await fs.writeFile(backImagePath, "back");

  t.after(async () => {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  process.env.OPENAI_API_KEY = "test-key";
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const userContent = body.input?.[1]?.content || [];
    const promptText = userContent.map((entry) => entry.text || "").join(" ");

    if (promptText.includes("parallel or colorway")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          output_text: JSON.stringify({
            playerName: null,
            year: null,
            setName: null,
            cardNumber: null,
            parallel: "Blue Refractor",
            sport: null,
            gradedFlag: false,
            grade: null,
            serialNumber: null,
            printRun: null,
            confidence: 0.84,
            notes: "parallel probe"
          })
        })
      };
    }

    if (promptText.includes("Front file name:")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          output_text: JSON.stringify({
            playerName: "Matas Buzelis",
            year: 2024,
            setName: "Panini Select Basketball",
            cardNumber: "70",
            parallel: "Blue Wave Prizm",
            sport: "basketball",
            gradedFlag: false,
            grade: null,
            serialNumber: "66/75",
            printRun: 75,
            confidence: 0.93,
            notes: "front vision"
          })
        })
      };
    }

    throw new Error("back vision failed");
  };

  const result = await extractCardMetadata({
    frontFileName: "front.jpg",
    backFileName: "back.jpg",
    frontImagePath,
    backImagePath
  });

  assert.equal(result.provider, "openai");
  assert.equal(result.playerName, "Matas Buzelis");
  assert.equal(result.serialNumber, "66/75");
  assert.equal(result.printRun, 75);
  assert.ok(result.notes.includes("Partial vision fallback"));
});

test("runs a parallel follow-up probe when the first pass misses the colorway", async (t) => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ocr-parallel-"));
  const frontImagePath = path.join(tempDir, `${randomUUID()}-front.jpg`);
  const backImagePath = path.join(tempDir, `${randomUUID()}-back.jpg`);

  await fs.writeFile(frontImagePath, "front");
  await fs.writeFile(backImagePath, "back");

  t.after(async () => {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  process.env.OPENAI_API_KEY = "test-key";
  let callCount = 0;
  global.fetch = async (_url, options) => {
    callCount += 1;
    const body = JSON.parse(options.body);
    const userContent = body.input?.[1]?.content || [];
    const promptText = userContent.map((entry) => entry.text || "").join(" ");

    if (promptText.includes("parallel or colorway")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          output_text: JSON.stringify({
            playerName: null,
            year: null,
            setName: null,
            cardNumber: null,
            parallel: "Blue Refractor",
            sport: null,
            gradedFlag: false,
            grade: null,
            serialNumber: null,
            printRun: null,
            confidence: 0.84,
            notes: "parallel probe"
          })
        })
      };
    }

    if (promptText.includes("Front file name:")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          output_text: JSON.stringify({
            playerName: "Islam Makhachev",
            year: 2025,
            setName: "Topps Chrome UFC",
            cardNumber: "TTC-19",
            parallel: null,
            sport: "UFC",
            gradedFlag: false,
            grade: null,
            serialNumber: null,
            printRun: null,
            confidence: 0.71,
            notes: "front vision"
          })
        })
      };
    }

    if (promptText.includes("Back file name:")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          output_text: JSON.stringify({
            playerName: null,
            year: null,
            setName: null,
            cardNumber: null,
            parallel: null,
            sport: null,
            gradedFlag: false,
            grade: null,
            serialNumber: "002/150",
            printRun: 150,
            confidence: 0.66,
            notes: "back vision"
          })
        })
      };
    }

    throw new Error(`Unexpected prompt in fetch call ${callCount}`);
  };

  const result = await extractCardMetadata({
    frontFileName: "front.jpg",
    backFileName: "back.jpg",
    frontImagePath,
    backImagePath
  });

  assert.equal(result.provider, "openai");
  assert.equal(result.parallel, "Blue Refractor");
  assert.equal(result.serialNumber, "002/150");
  assert.equal(result.printRun, 150);
  assert.ok(result.notes.includes("parallel probe"));
});
