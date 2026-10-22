import { describe, expect, it, vi } from "vitest";
import { sameName, ScanError, scanSerialPlate, scanTrainingCertificate, type ScanClient } from "./scan";

/** A fake API client returning `output` as the parsed result. */
const fake = (output: unknown, stop_reason = "end_turn") => {
  const parse = vi.fn().mockResolvedValue({ stop_reason, parsed_output: output });
  return { client: { beta: { messages: { parse } } } as unknown as ScanClient, parse };
};
const photo = { data: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" };
const types = [
  { id: 1, name: "Excavator operator" },
  { id: 2, name: "WHMIS" },
];
const card = {
  readable: true,
  holderName: "Jane  Smith",
  certificationAsPrinted: "Hydraulic Excavator Operator Training",
  certification: "excavator operator",
  issuedOn: "2026-03-14",
  expiresOn: "2029-03-14",
  provider: "Ontario Operator Training ",
  certificateNumber: "EX-4471",
};

describe("training certificates", () => {
  it("returns the fields, matching the company's certification, and sends the image with the list", async () => {
    const { client, parse } = fake(card);
    expect(await scanTrainingCertificate(photo, types, client)).toEqual({
      holderName: "Jane  Smith",
      certificationAsPrinted: "Hydraulic Excavator Operator Training",
      certificationTypeId: 1,
      issuedOn: "2026-03-14",
      expiresOn: "2029-03-14",
      provider: "Ontario Operator Training",
      certificateNumber: "EX-4471",
    });
    const request = parse.mock.calls[0][0];
    expect(request.model).toBe("claude-opus-5-5");
    expect(request.fallbacks).toBe("default");
    expect(request.messages[0].content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AQID" } });
    expect(request.messages[0].content[1].text).toContain("- WHMIS");
  });

  it("drops bad dates and an expiry before the issue date, and unknown certifications", async () => {
    const { client } = fake({ ...card, certification: "Crane", issuedOn: "14/03/2026", expiresOn: "2025-01-01" });
    expect(await scanTrainingCertificate(photo, types, client)).toMatchObject({ certificationTypeId: null, issuedOn: null, expiresOn: "2025-01-01" });
    const { client: c2 } = fake({ ...card, expiresOn: "2025-01-01" });
    expect((await scanTrainingCertificate(photo, types, c2)).expiresOn).toBeNull();
  });

  it("explains unreadable photos, refusals and wrong files", async () => {
    await expect(scanTrainingCertificate(photo, types, fake({ ...card, readable: false }).client)).rejects.toThrow(/readable training certificate/);
    await expect(scanTrainingCertificate(photo, types, fake(null, "refusal").client)).rejects.toBeInstanceOf(ScanError);
    await expect(scanTrainingCertificate({ ...photo, contentType: "image/gif" }, types, fake(card).client)).rejects.toThrow(/photo/);
  });

  it("sends PDFs as documents", async () => {
    const { client, parse } = fake(card);
    await scanTrainingCertificate({ ...photo, contentType: "application/pdf" }, types, client);
    expect(parse.mock.calls[0][0].messages[0].content[0]).toMatchObject({ type: "document", source: { media_type: "application/pdf" } });
  });

  it("compares names loosely", () => {
    expect(sameName("SMITH, Jane A.", "Jane Smith")).toBe(true);
    expect(sameName("Jose Garcia", "José García")).toBe(true);
    expect(sameName("Jane Smith", "Raj Patel")).toBe(false);
    expect(sameName("Jane Smith", "Jane Doe")).toBe(false);
  });
});

describe("serial plates", () => {
  it("returns make, model, year and serial, ignoring impossible years", async () => {
    const { client } = fake({ readable: true, make: "Caterpillar", model: "320", year: 2031, serialNumber: "CAT0320 GXYZ1234", machineType: "Excavator" });
    expect(await scanSerialPlate(photo, client, new Date("2026-10-22"))).toEqual({
      make: "Caterpillar",
      model: "320",
      year: null,
      serialNumber: "CAT0320GXYZ1234",
      machineType: "Excavator",
    });
  });
});
