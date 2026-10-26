import { beforeEach, describe, expect, it } from "vitest";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { deviceDiagnostics, devices } from "@/lib/db/schema";
import { DIAGNOSTIC_RULES, DiagnosticsError, deleteOldDiagnostics, parseDiagnostics, saveDiagnostics } from "./diagnostics";
import { restartLabel, restartReason } from "./restart-reasons";

describe("restart reasons", () => {
  it("reads names and ESP-IDF numbers", () => {
    expect(["panic", "PANIC", "4", "ESP_RST_PANIC"].map(restartReason)).toEqual(["panic", "panic", "panic", "panic"]);
    expect(restartReason("9")).toBe("brownout");
    expect(restartReason("bogus")).toBeNull();
    expect(restartLabel("bogus")).toBe('Reported as "bogus"');
    expect(restartLabel(null)).toBe("Not reported");
  });
});

describe("restart reports", () => {
  let db: Db;
  beforeEach(async () => {
    db = createDb();
    await migrateDb(db, false);
    await db.insert(devices).values({ id: "DEV1" });
  });

  it("splits the header from the log lines, dropping control characters and blank lines", () => {
    expect(parseDiagnostics("BOOT=12;RST=task_wdt\r\n[NET] Logout\n\n[OBD] ECU OFF\u0007\n")).toEqual({
      bootNumber: 12,
      restartReason: "task_wdt",
      lines: ["[NET] Logout", "[OBD] ECU OFF"],
    });
    expect(parseDiagnostics("just a line")).toEqual({ bootNumber: null, restartReason: null, lines: ["just a line"] });
  });

  it("stores reports from known devices only, keeping the latest ones", async () => {
    await expect(saveDiagnostics(db, "NOPE", "x")).rejects.toThrow(DiagnosticsError);
    for (let i = 0; i < DIAGNOSTIC_RULES.keepPerDevice + 3; i++) {
      await saveDiagnostics(db, "DEV1", `BOOT=${i};RST=poweron\nline ${i}`, new Date(Date.parse("2026-10-26T10:00:00Z") + i * 60_000));
    }
    const rows = await db.select().from(deviceDiagnostics).orderBy(deviceDiagnostics.bootNumber);
    expect(rows).toHaveLength(DIAGNOSTIC_RULES.keepPerDevice);
    expect(rows[0].bootNumber).toBe(3);
    expect(await deleteOldDiagnostics(db, new Date("2027-03-01T00:00:00Z"))).toBe(DIAGNOSTIC_RULES.keepPerDevice);
  });
});
