/**
 * Device simulator — pretends to be one or more Freematics ONE+ devices running the stock
 * Telelogger firmware in "HTTPS POST" mode. It calls exactly the same URLs, with exactly the
 * same data format, as the real device. Use it to test the platform without hardware.
 *
 *   npm run simulate                       # 3 machines → http://localhost:3000, every 5 s
 *   npm run simulate -- --devices 5 --interval 2
 *   npm run simulate -- --host https://your-app.vercel.app
 *   npm run simulate -- --once             # send one report from each machine and stop
 *   npm run simulate -- --engine on        # engines stay running (e.g. to test unauthorized-use alerts)
 *   npm run simulate -- --obd all          # every machine sends OBD-II engine data (default: machine 1 of every 3)
 *   npm run simulate -- --j1939 all        # every machine sends J1939 engine data (default: machine 3 of every 3)
 *   npm run simulate -- --fault            # J1939 machines report a fault code (coolant temperature) after ~1 minute
 *   npm run simulate -- --fuel-theft       # 15% of the fuel disappears while each engine is off (fuel theft alert)
 *
 * Each machine cycles its engine on and off (a few minutes each, so you can watch it happen),
 * unless --engine on / --engine off holds it in one state.
 * Machine 3 is a 24 V machine, like most heavy equipment, to exercise that detection path.
 * Machines with OBD-II (--obd) also send what the stock Telelogger reads from the engine computer while it
 * runs: RPM, engine load, throttle, coolant and intake temperature, speed, fuel level. Heavy equipment
 * usually speaks J1939 instead, which the stock firmware doesn't read: J1939 machines (--j1939) send what our
 * firmware fork will (hour meter, fuel rate and total, coolant, RPM, load, DEF, fault codes; docs/can-data.md).
 */
import { parseArgs } from "node:util";
import { encodePayload, type SampleFields } from "../src/lib/freematics/protocol";

const { values: args } = parseArgs({
  options: {
    host: { type: "string", default: process.env.SIM_HOST ?? "http://localhost:3000" },
    devices: { type: "string", default: "3" },
    interval: { type: "string", default: "5" },
    once: { type: "boolean", default: false },
    engine: { type: "string", default: "cycle" },
    obd: { type: "string", default: "some" },
    j1939: { type: "string", default: "some" },
    fault: { type: "boolean", default: false },
    "fuel-theft": { type: "boolean", default: false },
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
  hourMeter: number;
  totalFuelL: number;
  idleHours: number;
  idleFuelL: number;
  defPct: number;
}

const minutes = (min: number, max: number) => (min + Math.random() * (max - min)) * 60_000;

const devices: SimDevice[] = Array.from({ length: deviceCount }, (_, i) => ({
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
  j1939: args.j1939 === "all" || (args.j1939 === "some" && i % 3 === 2),
  obd: !(args.j1939 === "all" || (args.j1939 === "some" && i % 3 === 2)) && (args.obd === "all" || (args.obd === "some" && i % 3 === 0)),
  hourMeter: 1200 + i * 731.4,
  totalFuelL: 18_000 + i * 9_000,
  idleHours: 300 + i * 150.2,
  idleFuelL: 900 + i * 450,
  defPct: 70 + Math.random() * 25,
  coolantC: 20,
  fuelPct: 60 + Math.random() * 35,
}));

const simStart = Date.now();

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
  if (!working) {
    d.idleHours += intervalS / 3600;
    d.idleFuelL += (fuelRate * intervalS) / 3600;
  }
  d.coolantC = Math.min(88 + Math.random() * 4, d.coolantC + intervalS * 0.15);
  d.defPct = Math.max(3, d.defPct - (working ? 0.0005 : 0.0001) * intervalS);
  d.fuelPct = Math.max(5, d.fuelPct - (working ? 0.004 : 0.001) * intervalS);
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
    // Someone siphons fuel while the machine is parked: the level is lower when the engine starts again.
    if (d.engineOn && args["fuel-theft"] && (d.obd || d.j1939)) {
      d.fuelPct = Math.max(5, d.fuelPct - 15);
      console.log(`${d.id}: fuel siphoned while parked (now ${Math.round(d.fuelPct)}%)`);
    }
    d.nextSwitchAt = Date.now() + (d.engineOn ? minutes(3, 8) : minutes(1, 3));
    console.log(`${d.id}: engine ${d.engineOn ? "ON" : "OFF"}`);
  }
  const working = d.engineOn && Math.random() < d.duty;
  const speedKph = working ? 3 + Math.random() * 7 : 0;
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
    batteryCentivolts: Math.round(
      (d.system24V ? (d.engineOn ? 27.9 : 25.2) : d.engineOn ? 13.9 : 12.6) * 100 + Math.random() * 20,
    ),
    rssi: d.rssi,
    deviceTempC: 35 + Math.floor(Math.random() * 6),
    accel: [
      d.engineOn ? Number((Math.random() * 0.1 - 0.05).toFixed(2)) : 0,
      d.engineOn ? Number((Math.random() * 0.1 - 0.05).toFixed(2)) : 0,
      d.engineOn ? Number((0.95 + Math.random() * 0.1).toFixed(2)) : 1,
    ],
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
  await send(`/hub/api/notify/${d.id}?EV=1&SSI=${d.rssi}&VIN=`);
}

async function report(d: SimDevice) {
  const sample = nextSample(d);
  const reply = await send(`/hub/api/post/${d.id}`, { method: "POST", body: encodePayload([sample]) });
  console.log(
    `${new Date().toLocaleTimeString()}  ${d.id}  engine ${d.engineOn ? "on " : "off"}  ${sample.lat}, ${sample.lng}  ${sample.speedKph} km/h${sample.obdRpm ? `  ${sample.obdRpm} rpm (OBD)` : ""}${sample.j1939Rpm ? `  ${sample.j1939Rpm} rpm (J1939)${sample.j1939Faults ? "  FAULT" : ""}` : ""}  → ${reply}`,
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
