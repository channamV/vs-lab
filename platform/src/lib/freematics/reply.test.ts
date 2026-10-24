import { describe, expect, it } from "vitest";
import { deviceReply } from "./reply";

describe("deviceReply", () => {
  it("states the exact length in bytes, so the device knows when the reply ends", async () => {
    const res = deviceReply("OK 12\nCMD 3 ab BEEP=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("21");
    expect(await res.text()).toBe("OK 12\nCMD 3 ab BEEP=1");
    expect(deviceReply("Unknown device", 403).headers.get("content-length")).toBe("14");
    expect(deviceReply("é").headers.get("content-length")).toBe("2");
  });
});
