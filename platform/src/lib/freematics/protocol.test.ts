import { describe, expect, it } from "vitest";
import { checksum, encodePayload, parsePayload } from "./protocol";

describe("parsePayload", () => {
  it("parses an HTTP POST body from the Telelogger", () => {
    const body = "0:68021,10:12300000,A:43.653226,B:-79.383184,C:76.5,D:12.4,E:270,F:9,24:1312,81:-71,82:41,20:0.01;-0.02;0.98";
    const raw = `${body}*${checksum(body).toString(16).toUpperCase()}`;
    const parsed = parsePayload(raw);

    expect(parsed.checksumValid).toBe(true);
    expect(parsed.deviceId).toBeNull();
    expect(parsed.samples).toHaveLength(1);
    expect(parsed.samples[0]).toMatchObject({
      deviceMs: 68021,
      lat: 43.653226,
      lng: -79.383184,
      altitudeM: 76.5,
      speedKph: 12.4,
      heading: 270,
      satellites: 9,
      batteryCentivolts: 1312,
      rssi: -71,
      deviceTempC: 41,
      accel: [0.01, -0.02, 0.98],
    });
  });

  it("reads the device ID header used over UDP", () => {
    const parsed = parsePayload(encodePayload([{ deviceMs: 1, lat: 1, lng: 2 }], "ABC12345"));
    expect(parsed.deviceId).toBe("ABC12345");
    expect(parsed.checksumValid).toBe(true);
  });

  it("detects a corrupted payload", () => {
    const good = encodePayload([{ deviceMs: 1, lat: 43.1, lng: -79.1 }]);
    const bad = good.replace("43.1", "44.1");
    expect(parsePayload(bad).checksumValid).toBe(false);
  });

  it("splits multiple samples on the uptime field", () => {
    const parsed = parsePayload(encodePayload([{ deviceMs: 1000, lat: 1, lng: 1 }, { deviceMs: 2000, lat: 2, lng: 2 }]));
    expect(parsed.samples.map((s) => s.deviceMs)).toEqual([1000, 2000]);
  });

  it("names OBD and unknown PIDs", () => {
    const parsed = parsePayload("0:5,10C:1450,1FF:7");
    expect(parsed.checksumValid).toBeNull();
    expect(parsed.samples[0]).toEqual({ deviceMs: 5, obdRpm: 1450, pid_1FF: 7 });
  });

  it("round-trips through encodePayload", () => {
    const sample = { deviceMs: 42, lat: 53.349805, lng: -6.26031, speedKph: 3.5, accel: [0.1, 0.2, 0.9] };
    expect(parsePayload(encodePayload([sample])).samples).toEqual([sample]);
  });
});
