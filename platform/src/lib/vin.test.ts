import { describe, expect, it, vi } from "vitest";
import { decodeVin, equipmentMaker, lookupSerial, normalizeSerial, repairVin, titleCase, vinCheckDigit } from "./vin";

/** A fake fetch answering like NHTSA vPIC's DecodeVinValues. */
const vpic = (row: Record<string, string>) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify({ Count: 1, Message: "Results returned successfully", Results: [row] })));
const F550 = { Make: "FORD", Model: "F-550", ModelYear: "2013", VehicleType: "INCOMPLETE VEHICLE", BodyClass: "Incomplete - Chassis Cab (Single Cab)", ErrorCode: "0" };

describe("VIN check digit", () => {
  it("matches known-good VINs and catches a misread character", () => {
    expect(vinCheckDigit("1M8GDM9AXKP042788")).toBe("X");
    expect(vinCheckDigit("11111111111111111")).toBe("1");
    // One character misread (8 for B): the check digit no longer matches.
    expect(vinCheckDigit("1M8GDM9AXKP042788".replace("8G", "BG"))).not.toBe("X");
  });

  it("cleans up how serials are printed", () => {
    expect(normalizeSerial("1m8 gdm9a-xkp.042788")).toBe("1M8GDM9AXKP042788");
  });
});

describe("repairVin (scanned numbers)", () => {
  const VIN = "1M8GDM9AXKP042788";
  it("turns I, O and Q into 1 and 0, and fixes one look-alike character when only one fix fits the check digit", () => {
    expect(repairVin("1M8GDM9AXKP O42788")).toBe(VIN);
    expect(repairVin("1MBGDM9AXKP042788")).toBe(VIN); // 8 read as B
    expect(repairVin(VIN)).toBe(VIN);
  });
  it("leaves numbers alone when there's no single clear fix, and doesn't guess on equipment PINs", () => {
    expect(repairVin("1MB6DM9AXKP042788")).toBe("1MB6DM9AXKP042788"); // two misreads, no single swap fits
    expect(repairVin("CAT0320GXYZ1234O5")).toBe("CAT0320GXYZ123405"); // PIN: only the O → 0 fix
    expect(repairVin("ABC123")).toBe("ABC123");
  });
});

describe("lookupSerial", () => {
  it("decodes a VIN with NHTSA, title-casing the make", async () => {
    const fetch = vpic(F550);
    const r = await lookupSerial("1M8GDM9AXKP042788", fetch);
    expect(r).toEqual({
      kind: "vin",
      serial: "1M8GDM9AXKP042788",
      checkDigitOk: true,
      decoded: { make: "Ford", model: "F-550", year: 2013, machineType: "Incomplete - Chassis Cab (Single Cab)" },
    });
    expect(fetch.mock.calls[0][0]).toBe("https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/1M8GDM9AXKP042788?format=json");
  });

  it("flags a failed check digit even when NHTSA decodes it", async () => {
    const r = await lookupSerial("1M8GDM9A1KP042788", vpic(F550));
    expect(r).toMatchObject({ kind: "vin", checkDigitOk: false });
  });

  it("names equipment makers from a PIN without asking NHTSA", async () => {
    const fetch = vpic(F550);
    expect(await lookupSerial("CAT0320DCKBZ01234", fetch)).toEqual({ kind: "pin", serial: "CAT0320DCKBZ01234", manufacturer: "Caterpillar" });
    expect(equipmentMaker("KMTPC210V01023456")).toBe("Komatsu");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("explains numbers it can't look up", async () => {
    expect(await lookupSerial("ABC123", vpic(F550))).toMatchObject({ kind: "unknown", checkDigitOk: null });
    expect((await lookupSerial("1M8GDM9AXKP04278O", vpic(F550))).kind).toBe("unknown"); // letter O
    expect(await lookupSerial("1M8GDM9AXKP042788", vpic({ Make: "", ErrorCode: "7" }))).toMatchObject({ kind: "unknown", checkDigitOk: true });
  });
});

describe("decodeVin", () => {
  it("says so when NHTSA can't be reached or answers badly", async () => {
    expect(await decodeVin("1M8GDM9AXKP042788", vi.fn().mockRejectedValue(new Error("offline")))).toBe("unavailable");
    expect(await decodeVin("1M8GDM9AXKP042788", vi.fn().mockResolvedValue(new Response("busy", { status: 503 })))).toBe("unavailable");
    expect(await lookupSerial("1M8GDM9AXKP042788", vi.fn().mockRejectedValue(new Error("offline")))).toMatchObject({
      kind: "unknown",
      reason: expect.stringMatching(/Couldn't reach NHTSA/),
    });
  });

  it("ignores 'Not Applicable' and impossible years", async () => {
    expect(await decodeVin("1M8GDM9AXKP042788", vpic({ Make: "GMC", Model: "Not Applicable", ModelYear: "0", VehicleType: "TRUCK" }))).toEqual({
      make: "GMC",
      model: null,
      year: null,
      machineType: "Truck",
    });
  });
});

describe("titleCase", () => {
  it("keeps short brand names and capitalises words", () => {
    expect(titleCase("MERCEDES-BENZ")).toBe("Mercedes-Benz");
    expect(titleCase("JCB")).toBe("JCB");
    expect(titleCase("MULTIPURPOSE PASSENGER VEHICLE (MPV)")).toBe("Multipurpose Passenger Vehicle (MPV)");
  });
});
