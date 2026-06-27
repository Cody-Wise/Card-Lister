import test from "node:test";
import assert from "node:assert/strict";
import { matchCardIdentity } from "../src/services/matching.js";

test("matches a known Corbin Carroll card", () => {
  const result = matchCardIdentity({
    playerName: "Corbin Carroll",
    year: 2023,
    setName: "Topps Chrome",
    cardNumber: "95",
    gradedFlag: false,
  });
  assert.ok(result.canonicalCard);
  assert.equal(result.canonicalCard.playerName, "Corbin Carroll");
});
