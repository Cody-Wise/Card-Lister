import test from "node:test";
import assert from "node:assert/strict";
import { matchPairs } from "../src/services/drive.js";

// matchPairs is the core logic of the Google Drive import flow (pairs a
// scanned folder's front/back card images by filename before download), and
// had no direct test coverage — the README flags Google flows generally as
// weakly tested. The OAuth/network parts of drive.js go through the
// googleapis client rather than a mockable fetch() call, so this focuses on
// the pure, deterministic matching logic that flow depends on.
test("pairs files ending in 1/2 into front/back", () => {
  const result = matchPairs([
    { id: "a", name: "card1.jpg" },
    { id: "b", name: "card2.jpg" },
  ]);
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0].front.id, "a");
  assert.equal(result.pairs[0].back.id, "b");
  assert.equal(result.unmatched.length, 0);
});

test("groups multiple pairs independently by their shared base name", () => {
  const result = matchPairs([
    { id: "a1", name: "cardA1.png" },
    { id: "a2", name: "cardA2.png" },
    { id: "b1", name: "cardB1.png" },
    { id: "b2", name: "cardB2.png" },
  ]);
  assert.equal(result.pairs.length, 2);
  const bases = result.pairs.map((p) => p.base).sort();
  assert.deepEqual(bases, ["cardA", "cardB"]);
});

test("treats an unpaired front or back image as unmatched, not a false pair", () => {
  const result = matchPairs([
    { id: "a", name: "card1.jpg" },
    // no card2.jpg — front has no back
  ]);
  assert.equal(result.pairs.length, 0);
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.unmatched[0].id, "a");
});

test("treats a file with a number other than 1 or 2 as an orphan", () => {
  const result = matchPairs([{ id: "a", name: "card3.jpg" }]);
  assert.equal(result.pairs.length, 0);
  assert.equal(result.unmatched.length, 1);
});

test("treats a file with no trailing number as an orphan", () => {
  const result = matchPairs([{ id: "a", name: "notes.jpg" }]);
  assert.equal(result.pairs.length, 0);
  assert.equal(result.unmatched.length, 1);
});

test("ignores non-image files entirely (not even counted as orphans)", () => {
  const result = matchPairs([
    { id: "a", name: "readme.txt" },
    { id: "b", name: "data.json" },
  ]);
  assert.equal(result.pairs.length, 0);
  assert.equal(result.unmatched.length, 0);
});

test("recognizes uppercase and mixed-case image extensions", () => {
  const result = matchPairs([
    { id: "a", name: "card1.JPG" },
    { id: "b", name: "card2.WebP" },
  ]);
  assert.equal(result.pairs.length, 1);
});

test("handles an empty file list without throwing", () => {
  const result = matchPairs([]);
  assert.deepEqual(result, { pairs: [], unmatched: [] });
});
