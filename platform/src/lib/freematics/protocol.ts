/**
 * Freematics Telelogger data format.
 *
 * The stock Telelogger firmware (firmware_v5/telelogger in github.com/stanleyhuangyc/Freematics)
 * sends samples as text:
 *
 *   [DEVID#]PID:value[;value...],PID:value,...*CHECKSUM
 *
 *  - PID is hexadecimal. PID 0 is the device uptime in ms and starts each sample.
 *  - Values within one field are separated by ";" (e.g. accelerometer x;y;z).
 *  - CHECKSUM is hex: the sum of all bytes before "*", modulo 256.
 *  - The "DEVID#" header is only present over UDP. Over HTTP the device ID is in the URL.
 *
 * Example (HTTPS POST to /hub/api/post/ABC12345):
 *   0:68021,10:12300000,A:43.653226,B:-79.383184,C:76.5,D:12.4,E:270,F:9,24:1312,81:-71,82:41*5C
 */

/** Field names for the PIDs the Telelogger sends. OBD-II PIDs are sent as 0x100 + PID. */
export const PID_NAMES: Record<number, string> = {
  0x00: "deviceMs",
  0x0a: "lat",
  0x0b: "lng",
  0x0c: "altitudeM",
  0x0d: "speedKph",
  0x0e: "heading",
  0x0f: "satellites",
  0x10: "gpsTime",
  0x11: "gpsDate",
  0x12: "hdop",
  0x20: "accel",
  0x21: "gyro",
  0x22: "compass",
  0x24: "batteryCentivolts",
  0x25: "orientation",
  0x30: "tripDistanceM",
  0x81: "rssi",
  0x82: "deviceTempC",
  0x83: "hall",
  0x90: "extSensor1",
  0x91: "extSensor2",
  // OBD-II (0x100 | standard PID)
  0x104: "obdEngineLoadPct",
  0x105: "obdCoolantTempC",
  0x10c: "obdRpm",
  0x10d: "obdSpeedKph",
  0x10f: "obdIntakeTempC",
  0x111: "obdThrottlePct",
  0x11f: "obdRuntimeS",
  0x12f: "obdFuelLevelPct",
  0x142: "obdControlModuleV",
  0x146: "obdAmbientTempC",
  0x15c: "obdOilTempC",
  // J1939 (heavy equipment engine computers). Not sent by the stock Telelogger: these are VS Lab's own
  // PIDs for our firmware fork, which listens to the engine's J1939 broadcasts. See docs/can-data.md.
  0x301: "j1939EngineHours", // SPN 247, total engine hours (h)
  0x302: "j1939FuelRateLph", // SPN 183, fuel rate (L/h)
  0x303: "j1939TotalFuelL", // SPN 250, total fuel used (L)
  0x304: "j1939CoolantTempC", // SPN 110
  0x305: "j1939Rpm", // SPN 190
  0x306: "j1939EngineLoadPct", // SPN 92
  0x307: "j1939DefLevelPct", // SPN 1761, DEF (AdBlue) tank level
  0x308: "j1939IdleHours", // SPN 235, total idle hours (h)
  0x309: "j1939IdleFuelL", // SPN 236, total idle fuel used (L)
  0x30a: "j1939FuelLevelPct", // SPN 96, fuel tank level (%)
  0x310: "j1939Faults", // DM1 active faults: SPN × 32 + FMI each, ";"-separated; 0 = none active
  0x311: "j1939Lamps", // DM1 lamps: 1 = malfunction, 2 = red stop, 4 = amber warning, 8 = protect
};

const NAME_TO_PID: Record<string, number> = Object.fromEntries(
  Object.entries(PID_NAMES).map(([pid, name]) => [name, Number(pid)]),
);

export type SampleFields = Record<string, number | number[]>;

export interface ParsedPayload {
  deviceId: string | null;
  checksumValid: boolean | null; // null = no checksum present
  samples: SampleFields[];
}

export function checksum(text: string): number {
  let sum = 0;
  for (let i = 0; i < text.length; i++) sum = (sum + text.charCodeAt(i)) & 0xff;
  return sum;
}

export function parsePayload(raw: string): ParsedPayload {
  let body = raw.trim();
  let checksumValid: boolean | null = null;

  const star = body.lastIndexOf("*");
  if (star >= 0) {
    const expected = parseInt(body.slice(star + 1), 16);
    body = body.slice(0, star);
    checksumValid = !Number.isNaN(expected) && checksum(body) === expected;
  }

  let deviceId: string | null = null;
  const hash = body.indexOf("#");
  if (hash >= 0) {
    deviceId = body.slice(0, hash) || null;
    body = body.slice(hash + 1);
  }

  const samples: SampleFields[] = [];
  let current: SampleFields | null = null;

  for (const item of body.split(",")) {
    const colon = item.indexOf(":");
    if (colon <= 0) continue;
    const pid = parseInt(item.slice(0, colon), 16);
    if (Number.isNaN(pid)) continue;
    const values = item
      .slice(colon + 1)
      .split(";")
      .map(Number)
      .filter((v) => Number.isFinite(v));
    if (values.length === 0) continue;

    // PID 0 (uptime timestamp) marks the start of a new sample.
    if (pid === 0 || current === null) {
      current = {};
      samples.push(current);
    }
    const name = PID_NAMES[pid] ?? `pid_${pid.toString(16).toUpperCase()}`;
    current[name] = values.length === 1 ? values[0] : values;
  }

  return { deviceId, checksumValid, samples };
}

/** Build a payload in the exact format the Telelogger sends. Used by the simulator and tests. */
export function encodePayload(samples: SampleFields[], deviceId?: string): string {
  const parts: string[] = [];
  for (const sample of samples) {
    for (const [name, value] of Object.entries(sample)) {
      const pid = NAME_TO_PID[name] ?? (name.startsWith("pid_") ? parseInt(name.slice(4), 16) : NaN);
      if (Number.isNaN(pid)) continue;
      const values = Array.isArray(value) ? value : [value];
      parts.push(`${pid.toString(16).toUpperCase()}:${values.join(";")}`);
    }
  }
  const body = (deviceId ? `${deviceId}#` : "") + parts.join(",");
  return `${body}*${checksum(body).toString(16).toUpperCase()}`;
}

/** Numeric field value, or null if missing / not a single number. */
export function num(fields: SampleFields, name: string): number | null {
  const v = fields[name];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Telelogger connection event codes (EV= in /notify requests). */
export const EVENT_NAMES: Record<number, string> = {
  1: "login",
  2: "logout",
  3: "sync",
  4: "reconnect",
  5: "command",
  6: "ack",
  7: "ping",
};
