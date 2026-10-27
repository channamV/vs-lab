import { resumeProof } from "./hmac.ts";
import type { AppSession, HeldSession } from "./types.ts";

/**
 * Session hold rules (docs/operator-app.md), kept free of React Native so they can be tested with node. After a break
 * the phone proves to the device that it's the phone of the operator whose check-in it's holding: the device sends a
 * random challenge (nonce), the phone answers with the check-in details and HMAC(session key, nonce). The key itself
 * never leaves the phone.
 */

/** What the phone writes to the unlock characteristic to resume a held check-in. */
export const resumeMessage = (s: AppSession, nonce: string) =>
  `R1|${s.operatorId}|${s.checkinId}|${s.until}|${s.holdMinutes}|${resumeProof(s.key, nonce.trim())}`;

/** Device answers that mean the hold is over for this check-in (the phone forgets it). */
export const HOLD_OVER = ["NOT_HELD", "EXPIRED"];

/** Sessions still worth keeping at `now` (the key's valid-until hasn't passed). */
export const liveHolds = (list: HeldSession[], now = Date.now()) => list.filter((h) => h.session.until * 1000 > now);

/**
 * The server's list (with signal) decides which check-ins are still held; the phone keeps what it learnt itself (the
 * machine's Bluetooth id) for the ones that stay.
 */
export function mergeHolds(saved: HeldSession[], fromServer: Omit<HeldSession, "bleId">[], now = Date.now()): HeldSession[] {
  return liveHolds(
    fromServer.map((s) => ({ ...s, bleId: saved.find((h) => h.session.checkinId === s.session.checkinId)?.bleId ?? null })),
    now,
  );
}

/** Adds or replaces the hold for a machine (one per machine: a new check-in replaces the old one). */
export const withHold = (list: HeldSession[], h: HeldSession) => [...list.filter((x) => x.machineCode !== h.machineCode && x.session.checkinId !== h.session.checkinId), h];
