import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { liveHolds, mergeHolds, resumeMessage, withHold } from "./hold-rules.ts";
import type { HeldSession } from "./types.ts";

const now = Date.parse("2026-10-27T17:00:00Z");
const held = (checkinId: number, machineCode: string, untilMin: number, bleId: string | null = null): HeldSession => ({
  machineCode,
  deviceId: "DEV1",
  bluetoothName: "VS-DEV1",
  bleId,
  session: { checkinId, operatorId: 5, until: now / 1000 + untilMin * 60, holdMinutes: 90, key: "k".repeat(64) },
});

test("the resume message carries the check-in details and the proof for the device's challenge", () => {
  const h = held(42, "LDR1", 60);
  const proof = createHmac("sha256", h.session.key).update("resume\nabc123").digest("hex").slice(0, 16);
  assert.equal(resumeMessage(h.session, "abc123\n"), `R1|5|42|${h.session.until}|90|${proof}`);
});

test("the server's list decides, the phone keeps the machine's Bluetooth id, expired ones go", () => {
  const saved = [held(1, "LDR1", 60, "AA:BB"), held(2, "TRK1", 60, "CC:DD")];
  const merged = mergeHolds(saved, [held(1, "LDR1", 60), held(3, "EXC1", -1)].map(({ bleId: _b, ...rest }) => rest), now);
  assert.deepEqual(merged.map((h) => [h.session.checkinId, h.bleId]), [[1, "AA:BB"]]);
  assert.deepEqual(liveHolds(saved, now + 61 * 60_000), []);
});

test("one hold per machine: a new check-in replaces the old one", () => {
  const list = withHold([held(1, "LDR1", 60), held(2, "TRK1", 60)], held(7, "LDR1", 60));
  assert.deepEqual(list.map((h) => h.session.checkinId), [2, 7]);
});
