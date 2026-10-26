/**
 * Why a device restarted, as our firmware reports it (docs/device-diagnostics.md): the ESP32's own reset reason
 * (esp_reset_reason), sent as a name or the ESP-IDF number. Browser-safe: the staff device page shows the labels.
 * `kind` decides the tamper wording (src/lib/tamper.ts): power and brownout are things done to the machine; fault and
 * normal are the device itself.
 */
export const RESTART_REASONS = {
  poweron: { label: "Power was switched on (power cut, or first start)", kind: "power" },
  ext: { label: "Reset from outside (reset pin)", kind: "power" },
  brownout: { label: "Supply voltage dropped too low (weak battery or loose wiring)", kind: "brownout" },
  sw: { label: "Restarted by its own software (woke from sleep, update, command or recovery)", kind: "normal" },
  deepsleep: { label: "Woke from sleep", kind: "normal" },
  panic: { label: "Crashed (software fault)", kind: "fault" },
  int_wdt: { label: "Froze and was reset by its safety timer", kind: "fault" },
  task_wdt: { label: "Froze and was reset by its safety timer", kind: "fault" },
  wdt: { label: "Froze and was reset by its safety timer", kind: "fault" },
  sdio: { label: "Reset by the SDIO interface", kind: "normal" },
  unknown: { label: "Unknown reason", kind: "power" },
} as const;

export type RestartReason = keyof typeof RESTART_REASONS;

/** ESP-IDF esp_reset_reason_t numbers. */
const BY_NUMBER: RestartReason[] = ["unknown", "poweron", "ext", "sw", "panic", "int_wdt", "task_wdt", "wdt", "deepsleep", "brownout", "sdio"];

/** The names our firmware sends (feat/cell-beam 4d495a4; docs/hardware-bringup.md): its sleep wake-up restarts in software. */
const FIRMWARE_NAMES: Record<string, RestartReason> = {
  power_on: "poweron",
  software: "sw",
  crash: "panic",
  watchdog: "wdt",
  external: "ext",
};

/** A reported reason ("panic", "PANIC", "4", "ESP_RST_PANIC", "crash") as a known key, or null. */
export function restartReason(raw: string | null | undefined): RestartReason | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase().replace(/^esp_rst_/, "");
  if (/^\d+$/.test(v)) return BY_NUMBER[Number(v)] ?? null;
  if (v in FIRMWARE_NAMES) return FIRMWARE_NAMES[v];
  return v in RESTART_REASONS ? (v as RestartReason) : null;
}

export const restartLabel = (reason: string | null | undefined) => {
  const r = restartReason(reason);
  return r ? RESTART_REASONS[r].label : reason ? `Reported as "${reason}"` : "Not reported";
};
