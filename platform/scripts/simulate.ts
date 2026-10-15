/**
 * Device simulator — pretends to be one or more Freematics ONE+ devices running the stock
 * Telelogger firmware in "HTTPS POST" mode. It calls exactly the same URLs, with exactly the
 * same data format, as the real device. Use it to test the platform without hardware.
 *
 *   npm run simulate                       # 3 machines → http://localhost:3000, every 5 s
 *   npm run simulate -- --devices 5 --interval 2
 *   npm run simulate -- --host https://your-app.vercel.app
 *   npm run simulate -- --once             # send one report from each machine and stop
 */
import { parseArgs } from "node:util";
import { encodePayload, type SampleFields } from "../src/lib/freematics/protocol";

const { values: args } = parseArgs({
  options: {
    host: { type: "string", default: process.env.SIM_HOST ?? "http://localhost:3000" },
    devices: { type: "string", default: "3" },
    interval: { type: "string", default: "5" },
    once: { type: "boolean", default: false },
  },
});

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
}

const devices: SimDevice[] = Array.from({ length: deviceCount }, (_, i) => ({
  id: `SIM${String(i + 1).padStart(5, "0")}`,
  center: SITES[i % SITES.length],
  radiusM: 60 + 40 * (i % 3),
  angle: Math.random() * Math.PI * 2,
  duty: [0.8, 0.3, 0.6][i % 3],
  startedAt: Date.now(),
  rssi: -65 - Math.round(Math.random() * 20),
}));

function nextSample(d: SimDevice): SampleFields {
  const working = Math.random() < d.duty;
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
    // Alternator voltage while working, battery voltage while parked.
    batteryCentivolts: Math.round((working ? 13.9 : 12.6) * 100 + Math.random() * 20),
    rssi: d.rssi,
    deviceTempC: 35 + Math.floor(Math.random() * 6),
    accel: [
      Number((Math.random() * 0.1 - 0.05).toFixed(2)),
      Number((Math.random() * 0.1 - 0.05).toFixed(2)),
      working ? Number((0.95 + Math.random() * 0.1).toFixed(2)) : 1,
    ],
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
    `${new Date().toLocaleTimeString()}  ${d.id}  ${sample.lat}, ${sample.lng}  ${sample.speedKph} km/h  → ${reply}`,
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
