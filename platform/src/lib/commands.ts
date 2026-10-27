import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { deviceCommands, devices } from "@/lib/db/schema";

/**
 * Cloud-to-device commands (server side; the device side is our firmware fork, see docs/device-commands.md).
 *
 * The device can't be reached directly, so commands wait in a queue and go out in the reply to its next
 * contact: a data upload (every few seconds while running) or a check-in (every 15 minutes while parked).
 * Each reply line is `CMD <id> <signature> <command>`; the stock firmware only checks for HTTP 200 and
 * ignores the reply, so this doesn't affect it. The device runs the command and answers at
 * GET /hub/api/ack/<device>?id=&ok=&result=&sig=.
 *
 * Signatures: each device has its own key, derived from DEVICE_KEY_SECRET (env) and its ID, and written into
 * the device when it's flashed. Commands are signed so the device only runs ours; answers are signed so
 * nobody else can mark them done. Without DEVICE_KEY_SECRET, commands go out unsigned (for testing only).
 */

export class CommandError extends Error {}

export const COMMAND_RULES = {
  /** Commands not answered within this long expire. */
  expiresHours: 24,
  /**
   * Resend an unanswered command after this long, up to maxSends times. Firmware updates are exempt: the device only
   * acts on commands while it's awake (not at its 15-minute parked check-ins), so they're resent until answered or
   * their own expiry (7 days).
   */
  resendSeconds: 60,
  maxSends: 5,
  /** At most this many commands per reply. */
  perReply: 5,
};

/** The commands staff can send. `build` turns form values into the command line; null = invalid. */
export const COMMANDS = {
  report: {
    label: "Report now",
    help: "Send a full report straight away (position, battery, engine data).",
    build: () => ({ command: "REPORT", label: "Report now" }),
  },
  buzzer: {
    label: "Sound the buzzer",
    help: "Beep the device's buzzer, e.g. to find it in a machine, or to warn the operator.",
    build: (v: Record<string, string>) => {
      const n = Number(v.times || 3);
      return Number.isInteger(n) && n >= 1 && n <= 10 ? { command: `BEEP=${n}`, label: `Sound the buzzer ${n} time${n === 1 ? "" : "s"}` } : null;
    },
  },
  rate: {
    label: "Change reporting interval",
    help: "How often the device reports while the engine runs (1–60 seconds). Shorter = more detail and more data use.",
    build: (v: Record<string, string>) => {
      const s = Number(v.seconds);
      return Number.isInteger(s) && s >= 1 && s <= 60 ? { command: `RATE=${s}`, label: `Report every ${s} s while running` } : null;
    },
  },
  wifi: {
    label: "Set jobsite Wi-Fi",
    help: "Wi-Fi the device uses when there's no cellular coverage (2.4 GHz, password networks only).",
    build: (v: Record<string, string>) => {
      const ssid = (v.ssid ?? "").trim();
      const password = v.password ?? "";
      if (!ssid || ssid.length > 32 || password.length > 63 || /[\r\n]/.test(ssid + password)) return null;
      return { command: `WIFI=${ssid}\t${password}`, label: `Set Wi-Fi to "${ssid}"` };
    },
  },
  restart: {
    label: "Restart the device",
    help: "Reboot the device (it reconnects within a minute or two).",
    build: () => ({ command: "RESET", label: "Restart the device" }),
  },
} as const;
export type CommandKind = keyof typeof COMMANDS;

/** The device's own key (hex), or null when signing isn't set up. Staff copy it into the device when flashing. */
export function deviceKey(deviceId: string): string | null {
  const secret = process.env.DEVICE_KEY_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(`device-key:${deviceId}`).digest("hex").slice(0, 32);
}

const sign = (key: string, text: string) => createHmac("sha256", key).update(text).digest("hex").slice(0, 16);
const commandSignature = (key: string, deviceId: string, id: number, command: string) => sign(key, `${deviceId}\n${id}\n${command}`);
export const ackSignature = (key: string, deviceId: string, id: number, ok: boolean, result: string) =>
  sign(key, `ack\n${deviceId}\n${id}\n${ok ? 1 : 0}\n${result}`);
/** An unlock pass the operator app hands a relay device over Bluetooth (src/lib/operator-app.ts). */
export const unlockSignature = (key: string, deviceId: string, operatorId: number, checkinId: number, from: number, until: number) =>
  sign(key, `unlock\n${deviceId}\n${operatorId}\n${checkinId}\n${from}\n${until}`);

/**
 * Session hold (docs/operator-app.md): the secret the app keeps for one check-in, so the operator's phone can prove itself
 * to the device after a break. The device works it out from its own key and the details the phone sends (operator,
 * check-in, valid-until, hold minutes), so changing any of them breaks the proof. Full length: it's a key, not a tag.
 */
export const sessionKey = (key: string, deviceId: string, operatorId: number, checkinId: number, until: number, holdMinutes: number) =>
  createHmac("sha256", key).update(`session\n${deviceId}\n${operatorId}\n${checkinId}\n${until}\n${holdMinutes}`).digest("hex");
/** The phone's answer to the device's random challenge (nonce), proving it holds the session key. */
export const resumeProof = (sessionKeyHex: string, nonce: string) => sign(sessionKeyHex, `resume\n${nonce}`);
/** A relay device reporting that the operator's phone resumed a held check-in (/hub/api/access with c=). */
export const resumeSignature = (key: string, deviceId: string, operatorId: number, checkinId: number, t: number) =>
  sign(key, `resume\n${deviceId}\n${operatorId}\n${checkinId}\n${t}`);

/** A relay device reporting a beacon start (src/lib/relay.ts, /hub/api/access). */
export const accessSignature = (key: string, deviceId: string, operatorId: number, beacon: string, t: number) =>
  sign(key, `access\n${deviceId}\n${operatorId}\n${beacon}\n${t}`);

export async function queueCommand(
  db: Db,
  deviceId: string,
  kind: string,
  values: Record<string, string>,
  createdBy: string,
  now = new Date(),
) {
  if (!(kind in COMMANDS)) throw new CommandError("Unknown command.");
  const [device] = await db.select({ id: devices.id }).from(devices).where(eq(devices.id, deviceId));
  if (!device) throw new CommandError("Device not found.");
  const built = COMMANDS[kind as CommandKind].build(values);
  if (!built) throw new CommandError("Check the values for this command.");
  const [row] = await db
    .insert(deviceCommands)
    .values({ deviceId, ...built, createdBy, createdAt: now, expiresAt: new Date(now.getTime() + COMMAND_RULES.expiresHours * 3_600_000) })
    .returning();
  return row;
}

export async function cancelCommand(db: Db, deviceId: string, id: number) {
  await db
    .update(deviceCommands)
    .set({ status: "cancelled" })
    .where(and(eq(deviceCommands.id, id), eq(deviceCommands.deviceId, deviceId), inArray(deviceCommands.status, ["pending", "sent"])));
  await forgetSecrets(db, id);
}

/** Marks commands that ran out of time (or sends) as expired. */
async function expire(db: Db, deviceId: string, now: Date) {
  await db
    .update(deviceCommands)
    .set({ status: "expired" })
    .where(
      and(
        eq(deviceCommands.deviceId, deviceId),
        inArray(deviceCommands.status, ["pending", "sent"]),
        or(
          lt(deviceCommands.expiresAt, now),
          and(
            eq(deviceCommands.status, "sent"),
            isNull(deviceCommands.firmwareReleaseId),
            gte(deviceCommands.sendCount, COMMAND_RULES.maxSends),
            lt(deviceCommands.sentAt, new Date(now.getTime() - COMMAND_RULES.resendSeconds * 1000)),
          ),
        ),
      ),
    );
}

/**
 * The command lines to add to the reply to this device's report or check-in: new commands, and sent ones
 * not answered for a while (the device skips IDs it has already run). Never throws: a problem here must
 * not turn the device's HTTP 200 into an error.
 */
export async function commandsForReply(db: Db, deviceId: string, now = new Date()): Promise<string[]> {
  try {
    await expire(db, deviceId, now);
    const due = await db
      .select()
      .from(deviceCommands)
      .where(
        and(
          eq(deviceCommands.deviceId, deviceId),
          or(
            eq(deviceCommands.status, "pending"),
            and(
              eq(deviceCommands.status, "sent"),
              lt(deviceCommands.sentAt, new Date(now.getTime() - COMMAND_RULES.resendSeconds * 1000)),
              or(lt(deviceCommands.sendCount, COMMAND_RULES.maxSends), isNotNull(deviceCommands.firmwareReleaseId)),
            ),
          ),
        ),
      )
      // Mode changes first, unlocks before anything else (so a crew isn't left waiting), then oldest first.
      .orderBy(
        desc(sql`${deviceCommands.command} like 'MODE=unlocked%' or ${deviceCommands.command} like 'MODE=access_controlled%'`),
        desc(sql`${deviceCommands.command} like 'MODE=%'`),
        asc(deviceCommands.id),
      )
      .limit(COMMAND_RULES.perReply);
    if (due.length === 0) return [];
    const key = deviceKey(deviceId);
    const lines: string[] = [];
    for (const c of due) {
      await db
        .update(deviceCommands)
        .set({ status: "sent", sentAt: now, sendCount: c.sendCount + 1 })
        .where(eq(deviceCommands.id, c.id));
      lines.push(`CMD ${c.id} ${key ? commandSignature(key, deviceId, c.id, c.command) : "-"} ${c.command}`);
    }
    return lines;
  } catch (err) {
    console.error("Device commands failed", deviceId, err);
    return [];
  }
}

/** The reply body: the usual first line, then one line per command. */
export const withCommands = (first: string, lines: string[]) => [first, ...lines].join("\n");

/** The device's answer to a command. Throws CommandError for a bad signature or unknown command. */
export async function recordAnswer(
  db: Db,
  deviceId: string,
  answer: { id: number; ok: boolean; result: string; sig: string | null },
  now = new Date(),
) {
  const key = deviceKey(deviceId);
  if (key) {
    const expected = Buffer.from(ackSignature(key, deviceId, answer.id, answer.ok, answer.result));
    const given = Buffer.from(answer.sig ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new CommandError("Bad signature");
  }
  const updated = await db
    .update(deviceCommands)
    .set({ status: answer.ok ? "done" : "failed", answeredAt: now, result: answer.result.slice(0, 500) || null })
    .where(and(eq(deviceCommands.id, answer.id), eq(deviceCommands.deviceId, deviceId), inArray(deviceCommands.status, ["sent", "pending", "expired"])))
    .returning();
  if (updated.length === 0) throw new CommandError("Unknown command");
  await forgetSecrets(db, answer.id);
  return updated[0];
}

/** Once a Wi-Fi command is finished, the password isn't kept. */
async function forgetSecrets(db: Db, id: number) {
  const [c] = await db.select({ command: deviceCommands.command }).from(deviceCommands).where(eq(deviceCommands.id, id));
  if (c?.command.startsWith("WIFI=") && c.command.includes("\t")) {
    await db.update(deviceCommands).set({ command: `${c.command.split("\t")[0]}\t(password removed)` }).where(eq(deviceCommands.id, id));
  }
}

/** A device's command history, newest first (staff device page). */
export async function commandHistory(db: Db, deviceId: string, limit = 20) {
  await expire(db, deviceId, new Date());
  return db.select().from(deviceCommands).where(eq(deviceCommands.deviceId, deviceId)).orderBy(desc(deviceCommands.id)).limit(limit);
}
