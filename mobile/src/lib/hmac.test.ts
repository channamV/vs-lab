import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { hmacSha256Hex, resumeProof, sha256 } from "./hmac.ts";

const ascii = (t: string) => Uint8Array.from(t, (c) => c.charCodeAt(0));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

test("sha256 matches node for empty, short and multi-block inputs", () => {
  for (const t of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "x".repeat(200)]) {
    assert.equal(hex(sha256(ascii(t))), createHash("sha256").update(t).digest("hex"));
  }
});

test("HMAC matches node, including the session hold proof", () => {
  const key = createHmac("sha256", "0123456789abcdef0123456789abcdef").update("session\nDEV1\n5\n42\n1790000000\n90").digest("hex");
  assert.equal(hmacSha256Hex(key, "resume\nnonce"), createHmac("sha256", key).update("resume\nnonce").digest("hex"));
  assert.equal(hmacSha256Hex("k".repeat(100), "m"), createHmac("sha256", "k".repeat(100)).update("m").digest("hex"));
  assert.equal(resumeProof(key, "a1b2c3d4e5f60718"), createHmac("sha256", key).update("resume\na1b2c3d4e5f60718").digest("hex").slice(0, 16));
  assert.equal(resumeProof("-", "x"), "-");
});
