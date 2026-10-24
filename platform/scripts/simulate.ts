/**
 * Device simulator — pretends to be one or more Freematics ONE+ devices running the stock
 * Telelogger firmware in "HTTPS POST" mode. It calls exactly the same URLs, with exactly the
 * same data format, as the real device. Use it to test the platform without hardware.
 *
 *   npm run simulate                       # 4 machines → http://localhost:3000, every 5 s
 *   npm run simulate -- --devices 5 --interval 2
 *   npm run simulate -- --host https://your-app.vercel.app
 *   npm run simulate -- --once             # send one report from each machine and stop
 *   npm run simulate -- --engine on        # engines stay running (e.g. to test unauthorized-use alerts)
 *   npm run simulate -- --obd all          # every machine sends OBD-II engine data (default: machine 1 of every 3)
 *   npm run simulate -- --j1939 all        # every machine sends J1939 engine data (default: machine 3 of every 3)
 *   npm run simulate -- --fault            # J1939 machines report a fault code (coolant temperature) after ~1 minute
 *   npm run simulate -- --fuel-theft       # 15% of the fuel disappears while each engine is off (fuel theft alert)
 *   npm run simulate -- --refuel           # machines below half a tank are filled up while parked (fuel log)
 *   npm run simulate -- --siphon           # J1939 machines lose 15% of the tank while running, after ~4 minutes
 *   npm run simulate -- --speeding         # running machines drive at ~50 km/h for 30 s every 2 minutes (speeding)
 *   npm run simulate -- --idle             # running machines only idle, never work (excessive idling; needs RPM: --obd all)
 *
 *   npm run simulate -- --firmware vs-1.0.0  # the firmware version the devices report when they sign in (FW=)
 *
 * Device commands (docs/device-commands.md): the simulated devices act like our firmware fork. They read
 * commands from the replies, check the signature (with --device-secret, default $DEVICE_KEY_SECRET, the same
 * secret as the platform), run them and answer at /hub/api/ack.
 *
 * Simulated tanks are 400 L: set the machines' fuel tank size to 400 (npm run demo:seed does) so litres and
 * the "fuel lost while running" check work.
 *
 * Each machine cycles its engine on and off (a few minutes each, so you can watch it happen),
 * unless --engine on / --engine off holds it in one state.
 * Machine 3 is a 24 V machine, like most heavy equipment, to exercise that detection path.
 * Machine 4 of every 4 sends no supply voltage and no engine data, like a Telelogger built without OBD (the
 * bench-beam build), so the platform falls back to vibration to tell whether its engine runs.
 * The accelerometer is sent like the real device does: gravity removed (Telelogger subtracts its at-rest
 * reading at start-up), so about 0;0;0 when the engine is off and small values when it shakes the machine.
 * Machines with OBD-II (--obd) also send what the stock Telelogger reads from the engine computer while it
 * runs: RPM, engine load, throttle, coolant and intake temperature, speed, fuel level. Heavy equipment
 * usually speaks J1939 instead, which the stock firmware doesn't read: J1939 machines (--j1939) send what our
 * firmware fork will (hour meter, fuel rate and total, coolant, RPM, load, DEF, fault codes; docs/can-data.md).
 */
import { parseArgs } from "node:util";
import { createHash, createHmac } from "node:crypto";
import { encodePayload, type SampleFields } from "../src/lib/freematics/protocol";

const { values: args } = parseArgs({
  options: {
    host: { type: "string", default: process.env.SIM_HOST ?? "http://localhost:3000" },
    devices: { type: "string", default: "4" },
    interval: { type: "string", default: "5" },
    once: { type: "boolean", default: false },
    engine: { type: "string", default: "cycle" },
    obd: { type: "string", default: "some" },
    j1939: { type: "string", default: "some" },
    fault: { type: "boolean", default: false },
    "fuel-theft": { type: "boolean", default: false },
    refuel: { type: "boolean", default: false },
    siphon: { type: "boolean", default: false },
    speeding: { type: "boolean", default: false },
    idle: { type: "boolean", default: false },
    firmware: { type: "string", default: "sim-1.0.0" },
    "device-secret": { type: "string", default: process.env.DEVICE_KEY_SECRET ?? "" },
  },
});

if (!["cycle", "on", "off"].includes(args.engine!)) {
  console.error("--engine must be cycle, on or off");
  process.exit(1);
}
const engineMode = args.engine as "cycle" | "on" | "off";
for (const opt of ["obd", "j1939"] as const) {
  if (!["some", "all", "none"].includes(args[opt]!)) {
    console.error(`--${opt} must be some, all or none`);
    process.exit(1);
  }
}

const host = args.host!.replace(/\/$/, "");
const deviceCount = Math.max(1, Number(args.devices));
const intervalS = Math.max(1, Number(args.interval));

// Jobsites the simulated machines work around (Greater Toronto Area).
const SITES = [
  { lat: 43.6532, lng: -79.3832 },
  { lat: 43.7735, lng: -79.5019 },
  { lat: 43.5890, lng: -79.6441 },
  { lat: 43.8561, lng: -79.3370 },
  { lat: 43.2557, lng: -79.8711 },
];

interface SimDevice {
  id: string;
  center: { lat: number; lng: number };
  radiusM: number;
  angle: number;
  /** Fraction of the time the machine is working (moving). */
  duty: number;
  startedAt: number;
  rssi: number;
  engineOn: boolean;
  /** When the engine next switches on/off. */
  nextSwitchAt: number;
  system24V: boolean;
  /** Sends OBD-II engine data (RPM etc.) while running. */
  obd: boolean;
  coolantC: number;
  fuelPct: number;
  /** Sends J1939 engine data (our firmware fork) instead of OBD-II. */
  j1939: boolean;
  /** Sends no supply voltage or engine data (a Telelogger without OBD): only vibration shows the engine state. */
  vibrationOnly: boolean;
  hourMeter: number;
  totalFuelL: number;
  idleHours: number;
  idleFuelL: number;
  defPct: number;
  /** --siphon: percentage points still to be taken while running. */
  siphonLeft: number;
  siphoned: boolean;
  /** Firmware version it reports (FW=); changes when an update installs. */
  firmware: string;
  /** Commands already run (the firmware remembers the last ID, so a resent command isn't run twice). */
  lastCommandId: number;
  rateS: number | null;
}

const minutes = (min: number, max: number) => (min + Math.random() * (max - min)) * 60_000;
const g2 = (v: number) => Number(v.toFixed(2));
/** A running engine's shake as Telelogger reports it: gravity removed, in g; always above the platform's 0.05 g. */
const shake = () => [g2(Math.random() * 0.06 - 0.03), g2(Math.random() * 0.06 - 0.03), g2(0.05 + Math.random() * 0.04)];

const devices: SimDevice[] = Array.from({ length: deviceCount }, (_, i) => {
  const vibrationOnly = i % 4 === 3;
  // "some": machine 3 of every 3 speaks J1939, machine 1 of every 3 OBD-II, skipping vibration-only machines.
  const j1939 = args.j1939 === "all" || (args.j1939 === "some" && i % 3 === 2 && !vibrationOnly);
  const obd = !j1939 && (args.obd === "all" || (args.obd === "some" && i % 3 === 0 && !vibrationOnly));
  return {
    id: `SIM${String(i + 1).padStart(5, "0")}`,
    center: SITES[i % SITES.length],
    radiusM: 60 + 40 * (i % 3),
    angle: Math.random() * Math.PI * 2,
    duty: [0.8, 0.3, 0.6][i % 3],
    startedAt: Date.now(),
    rssi: -65 - Math.round(Math.random() * 20),
    engineOn: engineMode === "cycle" ? i % 2 === 0 : engineMode === "on",
    nextSwitchAt: Date.now() + minutes(1, 4),
    system24V: i % 3 === 2,
    j1939,
    obd,
    vibrationOnly,
    hourMeter: 1200 + i * 731.4,
    totalFuelL: 18_000 + i * 9_000,
    idleHours: 300 + i * 150.2,
    idleFuelL: 900 + i * 450,
    siphonLeft: 0,
    siphoned: false,
    firmware: args.firmware!,
    lastCommandId: 0,
    rateS: null,
    defPct: 70 + Math.random() * 25,
    coolantC: 20,
    fuelPct: 60 + Math.random() * 35,
  };
});

const simStart = Date.now();
/** Simulated tank size: the level falls by exactly what the engine burns. */
const TANK_L = 400;

/**
 * What our firmware fork will send from a J1939 engine computer. The hour meter and fuel totals only move
 * while the engine runs. With --fault, a coolant temperature fault (SPN 110 FMI 15) appears after a minute
 * of running and clears two minutes later.
 */
function j1939Fields(d: SimDevice, working: boolean): SampleFields {
  if (!d.j1939) return {};
  const meters = () => ({
    j1939EngineHours: Number(d.hourMeter.toFixed(2)),
    j1939TotalFuelL: Number(d.totalFuelL.toFixed(1)),
    j1939IdleHours: Number(d.idleHours.toFixed(2)),
    j1939IdleFuelL: Number(d.idleFuelL.toFixed(1)),
  });
  const fields: SampleFields = meters();
  if (!d.engineOn) return fields;
  const fuelRate = working ? 14 + Math.random() * 10 : 2.5 + Math.random();
  d.hourMeter += intervalS / 3600;
  d.totalFuelL += (fuelRate * intervalS) / 3600;
  d.fuelPct = Math.max(5, d.fuelPct - ((fuelRate * intervalS) / 3600 / TANK_L) * 100);
  if (args.siphon && !d.siphoned && Date.now() - simStart > 4 * 60_000) {
    d.siphoned = true;
    d.siphonLeft = 15;
    console.log(`${d.id}: fuel being siphoned while running`);
  }
  if (d.siphonLeft > 0) {
    const take = Math.min(1.5, d.siphonLeft);
    d.siphonLeft -= take;
    d.fuelPct = Math.max(5, d.fuelPct - take);
  }
  if (!working) {
    d.idleHours += intervalS / 3600;
    d.idleFuelL += (fuelRate * intervalS) / 3600;
  }
  d.coolantC = Math.min(88 + Math.random() * 4, d.coolantC + intervalS * 0.15);
  d.defPct = Math.max(3, d.defPct - (working ? 0.0005 : 0.0001) * intervalS);
  const elapsed = (Date.now() - simStart) / 60_000;
  const faulty = args.fault && elapsed > 1 && elapsed < 3;
  return {
    ...fields,
    ...meters(),
    j1939FuelRateLph: Number(fuelRate.toFixed(1)),
    j1939CoolantTempC: Math.round(faulty ? 104 : d.coolantC),
    j1939Rpm: Math.round(working ? 1600 + Math.random() * 500 : 750 + Math.random() * 100),
    j1939EngineLoadPct: Math.round(working ? 50 + Math.random() * 35 : 10 + Math.random() * 8),
    j1939DefLevelPct: Math.round(d.defPct),
    j1939FuelLevelPct: Number(d.fuelPct.toFixed(1)),
    j1939Faults: faulty ? 110 * 32 + 15 : 0,
    j1939Lamps: faulty ? 4 : 0,
  };
}

/** What the Telelogger polls over OBD-II while the engine runs (the engine computer is off otherwise). */
function obdFields(d: SimDevice, working: boolean, speedKph: number): SampleFields {
  if (!d.obd || !d.engineOn) return {};
  d.coolantC = Math.min(88 + Math.random() * 4, d.coolantC + intervalS * 0.15);
  d.fuelPct = Math.max(5, d.fuelPct - (working ? 0.004 : 0.001) * intervalS);
  const rpm = working ? 1500 + Math.random() * 600 : 750 + Math.random() * 100;
  return {
    obdRpm: Math.round(rpm),
    obdEngineLoadPct: Math.round(working ? 45 + Math.random() * 35 : 12 + Math.random() * 8),
    obdThrottlePct: Math.round(working ? 35 + Math.random() * 40 : 0),
    obdCoolantTempC: Math.round(d.coolantC),
    obdIntakeTempC: 18 + Math.round(Math.random() * 6),
    obdSpeedKph: Math.round(speedKph),
    obdFuelLevelPct: Math.round(d.fuelPct),
  };
}

function nextSample(d: SimDevice): SampleFields {
  if (engineMode === "cycle" && Date.now() >= d.nextSwitchAt) {
    d.engineOn = !d.engineOn;
    if (d.engineOn && args.refuel && (d.obd || d.j1939) && d.fuelPct < 50) {
      console.log(`${d.id}: refuelled while parked (${Math.round(d.fuelPct)}% → 95%)`);
      d.fuelPct = 95;
    }
    // Someone siphons fuel while the machine is parked: the level is lower when the engine starts again.
    if (d.engineOn && args["fuel-theft"] && (d.obd || d.j1939)) {
      d.fuelPct = Math.max(5, d.fuelPct - 15);
      console.log(`${d.id}: fuel siphoned while parked (now ${Math.round(d.fuelPct)}%)`);
    }
    d.nextSwitchAt = Date.now() + (d.engineOn ? minutes(3, 8) : minutes(1, 3));
    console.log(`${d.id}: engine ${d.engineOn ? "ON" : "OFF"}`);
  }
  const fast = args.speeding && d.engineOn && (Date.now() - simStart) % 120_000 < 30_000;
  const working = d.engineOn && !args.idle && (fast || Math.random() < d.duty);
  const speedKph = fast ? 48 + Math.random() * 6 : working ? 3 + Math.random() * 7 : 0;
  // Move along a circle around the jobsite.
  d.angle += ((speedKph / 3.6) * intervalS) / d.radiusM;
  const dLat = (d.radiusM * Math.cos(d.angle)) / 111_320;
  const dLng = (d.radiusM * Math.sin(d.angle)) / (111_320 * Math.cos((d.center.lat * Math.PI) / 180));
  const headingDeg = Math.round((((d.angle * 180) / Math.PI + 90) % 360 + 360) % 360);
  d.rssi = Math.max(-110, Math.min(-50, d.rssi + Math.round(Math.random() * 6 - 3)));

  return {
    deviceMs: Date.now() - d.startedAt,
    lat: Number((d.center.lat + dLat).toFixed(6)),
    lng: Number((d.center.lng + dLng).toFixed(6)),
    altitudeM: 90,
    speedKph: Number(speedKph.toFixed(1)),
    heading: headingDeg,
    satellites: 8 + Math.floor(Math.random() * 5),
    // Alternator charging voltage while the engine runs, resting battery voltage when off.
    ...(!d.vibrationOnly && {
      batteryCentivolts: Math.round(
        (d.system24V ? (d.engineOn ? 27.9 : 25.2) : d.engineOn ? 13.9 : 12.6) * 100 + Math.random() * 20,
      ),
    }),
    rssi: d.rssi,
    deviceTempC: 35 + Math.floor(Math.random() * 6),
    accel: d.engineOn ? shake() : [0, 0, 0],
    ...obdFields(d, working, speedKph),
    ...j1939Fields(d, working),
  };
}

async function send(path: string, init?: RequestInit): Promise<string> {
  const res = await fetch(`${host}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return text;
}

async function login(d: SimDevice) {
  await handleReply(d, await send(`/hub/api/notify/${d.id}?EV=1&SSI=${d.rssi}&VIN=&FW=${encodeURIComponent(d.firmware)}`));
}

/**
 * UPDATE=<version>\t<bytes>\t<sha256>\t<path>: download in pieces (as our firmware will: the modem fails on
 * the whole file at once), retrying a piece and making pieces smaller when transfers fail; then check the
 * whole file's size and fingerprint before "installing" and restarting.
 */
async function update(d: SimDevice, value: string): Promise<[boolean, string]> {
  const [version, bytes, sha256, path] = value.split("\t");
  const size = Number(bytes);
  const data = new Uint8Array(size);
  let piece = 16_384;
  let pieces = 0;
  for (let offset = 0; offset < size; ) {
    const end = Math.min(offset + piece, size) - 1;
    let got: Uint8Array | null = null;
    for (let attempt = 0; attempt < 3 && !got; attempt++) {
      const res = await fetch(`${host}${path}`, { headers: { Range: `bytes=${offset}-${end}` } }).catch(() => null);
      if (res?.status === 403) return [false, "download refused (403)"];
      const body = res?.status === 206 ? new Uint8Array(await res.arrayBuffer()) : null;
      if (body && body.length === end - offset + 1) got = body;
    }
    if (!got) {
      if (piece <= 4096) return [false, `download failed at byte ${offset}`];
      piece /= 2;
      continue;
    }
    data.set(got, offset);
    offset += got.length;
    pieces++;
  }
  if (createHash("sha256").update(data).digest("hex") !== sha256) return [false, "SHA-256 mismatch: not installed"];
  console.log(`${d.id}: ⬇ downloaded ${version} in ${pieces} pieces (${(size / 1e6).toFixed(2)} MB, fingerprint OK), installing and restarting`);
  d.firmware = version;
  await send(`/hub/api/notify/${d.id}?EV=2&SSI=${d.rssi}`);
  await send(`/hub/api/notify/${d.id}?EV=1&SSI=${d.rssi}&VIN=&FW=${encodeURIComponent(d.firmware)}`);
  return [true, `running ${version}`];
}

// ---------- Device commands (what our firmware fork will do) ----------

const secret = args["device-secret"]!;
/** The device's key, derived like the platform does (src/lib/commands.ts deviceKey). */
const keyFor = (id: string) => (secret ? createHmac("sha256", secret).update(`device-key:${id}`).digest("hex").slice(0, 32) : null);
const hmac16 = (key: string, text: string) => createHmac("sha256", key).update(text).digest("hex").slice(0, 16);

async function handleReply(d: SimDevice, reply: string) {
  for (const line of reply.split("\n").slice(1)) {
    const m = /^CMD (\d+) (\S+) (.*)$/.exec(line);
    if (!m) continue;
    const id = Number(m[1]);
    const [, , sig, command] = m;
    if (id <= d.lastCommandId) continue; // already run; the answer may have been lost, so answer again below
    const key = keyFor(d.id);
    if (key && sig !== hmac16(key, `${d.id}\n${id}\n${command}`)) {
      console.log(`${d.id}: ignored command #${id} with a bad signature`);
      continue;
    }
    d.lastCommandId = id;
    let ok = true;
    let result = "OK";
    const eq = command.indexOf("=");
    const name = eq < 0 ? command : command.slice(0, eq);
    const value = eq < 0 ? "" : command.slice(eq + 1);
    if (name === "REPORT") result = "reported";
    else if (name === "BEEP") console.log(`${d.id}: 🔔 beep ×${value}`);
    else if (name === "RATE") {
      d.rateS = Number(value);
      result = `every ${value} s`;
      console.log(`${d.id}: reporting interval set to ${value} s (the simulator keeps its own pace)`);
    } else if (name === "WIFI") {
      const ssid = value.split("\t")[0];
      result = `saved ${ssid}`;
      console.log(`${d.id}: Wi-Fi set to "${ssid}"`);
    } else if (name === "RESET") {
      console.log(`${d.id}: restarting`);
      await send(`/hub/api/notify/${d.id}?EV=2&SSI=${d.rssi}`);
      await send(`/hub/api/notify/${d.id}?EV=1&SSI=${d.rssi}&VIN=&FW=${encodeURIComponent(d.firmware)}`);
    } else if (name === "MODE") {
      // Our firmware would set the ignition relay and remember the offline fallback.
      const [mode, offline, hours] = value.split("\t");
      result = `enforcing ${mode}`;
      console.log(`${d.id}: 🔐 mode ${mode}${offline !== "keep" ? `, ${offline} after ${hours} h offline` : ""}`);
    } else if (name === "UPDATE") {
      [ok, result] = await update(d, value).catch((err) => [false, `update failed: ${err.message}`] as [boolean, string]);
    } else {
      ok = false;
      result = `unknown command ${name}`;
    }
    console.log(`${d.id}: ran command #${id} ${name} → ${result}`);
    const ackSig = key ? hmac16(key, `ack\n${d.id}\n${id}\n${ok ? 1 : 0}\n${result}`) : "-";
    await send(`/hub/api/ack/${d.id}?id=${id}&ok=${ok ? 1 : 0}&result=${encodeURIComponent(result)}&sig=${ackSig}`).catch((err) =>
      console.error(`${d.id}: answer to #${id} failed: ${err.message}`),
    );
    if (name === "REPORT") await report(d);
  }
}

async function report(d: SimDevice) {
  const sample = nextSample(d);
  const reply = await send(`/hub/api/post/${d.id}`, { method: "POST", body: encodePayload([sample]) });
  await handleReply(d, reply);
  console.log(
    `${new Date().toLocaleTimeString()}  ${d.id}  engine ${d.engineOn ? "on " : "off"}  ${sample.lat}, ${sample.lng}  ${sample.speedKph} km/h${sample.obdRpm ? `  ${sample.obdRpm} rpm (OBD)` : ""}${sample.j1939Rpm ? `  ${sample.j1939Rpm} rpm (J1939)${sample.j1939Faults ? "  FAULT" : ""}` : ""}  → ${reply.split("\n")[0]}`,
  );
}

async function main() {
  console.log(`Simulating ${deviceCount} device(s) → ${host}  (every ${intervalS}s, Ctrl+C to stop)`);
  try {
    await Promise.all(devices.map(login));
  } catch (err) {
    console.error(`\nCan't reach ${host}: ${(err as Error).message}`);
    console.error("Is the platform running? Start it with: npm run dev");
    process.exit(1);
  }

  do {
    await Promise.all(devices.map((d) => report(d).catch((err) => console.error(`${d.id}: ${err.message}`))));
    if (!args.once) await new Promise((r) => setTimeout(r, intervalS * 1000));
  } while (!args.once);
}

main();
