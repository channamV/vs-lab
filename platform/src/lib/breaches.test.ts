import { beforeEach, describe, expect, it } from "vitest";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { applyRetention } from "@/lib/privacy";
import { BreachError, listBreaches, recordBreach, updateBreach, type BreachInput } from "./breaches";

let db: Db;
const now = new Date("2026-10-22T15:00:00Z");
const blank: BreachInput = {
  occurredAt: "",
  discoveredAt: "2026-10-20",
  description: "Laptop with an export of operator names stolen",
  dataInvolved: "",
  organizationsAffected: "",
  peopleAffected: "",
  realRisk: "",
  riskReasoning: "",
  reportedToCommissionerAt: "",
  individualsNotifiedAt: "",
  customersNotifiedAt: "",
  actionsTaken: "",
  closed: false,
};

beforeEach(async () => {
  db = createDb();
  await migrateDb(db, false);
});

describe("breach register", () => {
  it("records a breach and lists what's still to do", async () => {
    const b = await recordBreach(db, { ...blank, occurredAt: "2026-10-19", peopleAffected: "12" }, "craig@veristart.ca", now);
    expect(b).toMatchObject({ peopleAffected: 12, realRiskOfSignificantHarm: null, closedAt: null });
    expect(b.discoveredAt.toISOString()).toBe("2026-10-20T12:00:00.000Z");
    const [listed] = await listBreaches(db);
    expect(listed.todo).toEqual(["Assess the risk of significant harm", "Record what was done to contain it"]);
    await updateBreach(db, b.id, { ...blank, realRisk: "yes", actionsTaken: "Passwords reset" }, now);
    expect((await listBreaches(db))[0].todo).toEqual([
      "Report to the Privacy Commissioner",
      "Notify the people affected",
      "Tell the customers whose data it was",
    ]);
  });

  it("won't close a record that still needs reporting", async () => {
    const b = await recordBreach(db, blank, "craig", now);
    await expect(updateBreach(db, b.id, { ...blank, closed: true }, now)).rejects.toThrow(/Assess the risk/);
    await expect(updateBreach(db, b.id, { ...blank, realRisk: "yes", closed: true }, now)).rejects.toThrow(/Commissioner/);
    await updateBreach(db, b.id, { ...blank, realRisk: "no", riskReasoning: "Encrypted disk", actionsTaken: "Wiped remotely", closed: true }, now);
    const [closed] = await listBreaches(db);
    expect(closed.closedAt).toEqual(now);
    expect(closed.todo).toEqual([]);
  });

  it("checks dates and required fields", async () => {
    await expect(recordBreach(db, { ...blank, description: " " }, "craig", now)).rejects.toThrow(BreachError);
    await expect(recordBreach(db, { ...blank, discoveredAt: "" }, "craig", now)).rejects.toThrow(/discovered/);
    await expect(recordBreach(db, { ...blank, occurredAt: "2026-10-21" }, "craig", now)).rejects.toThrow(/after it was discovered/);
    await expect(recordBreach(db, { ...blank, peopleAffected: "many" }, "craig", now)).rejects.toThrow(/whole number/);
  });

  it("is never removed by the retention clean-up", async () => {
    await db.insert(organizations).values({ name: "ABC" });
    await recordBreach(db, blank, "craig", now);
    await applyRetention(db, new Date("2030-01-01T00:00:00Z"));
    expect(await listBreaches(db)).toHaveLength(1);
  });
});
