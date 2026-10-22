/**
 * Operating modes (docs/operating-modes.md). Browser-safe: the machine page uses these too.
 * Database logic is in src/lib/modes.ts.
 */
export const MODES = {
  access_controlled: { label: "Access-Controlled", short: "Only approved operators can start the machine." },
  unlocked: { label: "Unlocked", short: "Anyone can start it; usage is still tracked." },
  locked: { label: "Locked", short: "No one can start it." },
} as const;
export type Mode = keyof typeof MODES;
export const isMode = (v: unknown): v is Mode => typeof v === "string" && v in MODES;

type Tier = "gps" | "monitor" | "control";

/** The modes a tier offers. GPS & Telematics has no check-ins, so no Access-Controlled. */
export function modesFor(tier: Tier): Mode[] {
  return tier === "gps" ? ["unlocked", "locked"] : ["access_controlled", "unlocked", "locked"];
}

/** What each mode does on this tier, in plain words. */
export function modeMeaning(mode: Mode, tier: Tier): string {
  if (tier === "control") {
    return {
      access_controlled: "The ignition relay only allows a start for an approved, checked-in operator.",
      unlocked: "The relay always allows a start, like a normal key. Usage is still recorded.",
      locked: "The relay prevents starting. A running engine is never stopped.",
    }[mode];
  }
  if (tier === "monitor") {
    return {
      access_controlled: "Starting without a check-in raises an Unauthorized use alert.",
      unlocked: "Anyone can use it without checking in. Usage is still recorded.",
      locked: "Any engine start or movement raises an alert straight away, and check-ins are refused.",
    }[mode];
  }
  return {
    access_controlled: "Not available on GPS & Telematics.",
    unlocked: "Normal tracking.",
    locked: "Alarmed: any engine start or movement raises an alert straight away.",
  }[mode];
}

/** The mode in force at `now`: a timed change that has run out has returned to its revert mode. */
export function currentMode(
  m: { mode: string; modeUntil: Date | null; modeRevertTo: string | null; tier: Tier },
  now = Date.now(),
): Mode {
  const raw = m.modeUntil && m.modeUntil.getTime() <= now && m.modeRevertTo ? m.modeRevertTo : m.mode;
  const mode: Mode = isMode(raw) ? raw : "unlocked";
  // GPS & Telematics has no check-ins: Access-Controlled behaves as Unlocked.
  return m.tier === "gps" && mode === "access_controlled" ? "unlocked" : mode;
}
