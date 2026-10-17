import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { alerts, devices, engineSessions } from "@/lib/db/schema";
import { CHECKLIST } from "@/lib/checklist";
import { CHECKIN_RULES, checkIn, checkOut, createOperator, setMachineOperators, syncCheckins } from "@/lib/operators";
import { acknowledgeAlert, ALERT_RULES, checkUnauthorizedUse, isArmed, raiseCheckinAlerts } from "./alerts";
import { alertEmail, deliverAlerts } from "./notify";

let db: Db;
const allOk = Object.fromEntries(CHECKLIST.map((item) => [item.id, true]));
const t0 = new Date("2026-10-15T12:00:00Z");
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
const grace = ALERT_RULES.unauthorizedGraceMinutes;

beforeEach(async () => {
  db = createDb();
  await migrateDb(db, false);
  // A monitored machine whose engine started at t0
  await db.insert(devices).values({ id: "DEV1", name: "Excavator 14", tier: "monitor", engineOn: true, lastLat: 43.65, lastLng: -79.38 });
  await db.insert(engineSessions).values({ deviceId: "DEV1", startedAt: t0, lastSeenAt: t0 });
  await createOperator(db, { name: "Jane", pin: "1111" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("unauthorized use", () => {
  it("alerts once when the engine runs past the grace period with nobody checked in", async () => {
    expect(await checkUnauthorizedUse(db, "DEV1", at(grace - 1))).toHaveLength(0);
    const [alert] = await checkUnauthorizedUse(db, "DEV1", at(grace + 1));
    expect(alert).toMatchObject({ type: "unauthorized-use", title: "Unauthorized use: Excavator 14" });
    expect(alert.detail).toContain(`running for ${grace + 1} min with nobody checked in`);
    // Later reports in the same engine-on period don't raise it again
    expect(await checkUnauthorizedUse(db, "DEV1", at(grace + 10))).toHaveLength(0);
    expect(await db.select().from(alerts)).toHaveLength(1);
  });

  it("doesn't alert when someone is checked in", async () => {
    await checkIn(db, { deviceId: "DEV1", pin: "1111", answers: allOk }, at(1));
    expect(await checkUnauthorizedUse(db, "DEV1", at(grace + 5))).toHaveLength(0);
  });

  it("alerts when the engine keeps running after the operator checks out", async () => {
    await checkIn(db, { deviceId: "DEV1", pin: "1111", answers: allOk }, at(-2));
    await syncCheckins(db, "DEV1", at(1)); // engine started at 0 → linked
    await db.update(engineSessions).set({ lastSeenAt: at(20) }); // engine still reporting
    expect(await checkOut(db, { deviceId: "DEV1", pin: "1111" }, at(20))).toMatchObject({ ok: true });
    expect(await checkUnauthorizedUse(db, "DEV1", at(20 + grace - 1))).toHaveLength(0);
    expect(await checkUnauthorizedUse(db, "DEV1", at(20 + grace + 1))).toHaveLength(1);
  });

  it("alerts on a restart after the operator's engine-on period ended", async () => {
    await checkIn(db, { deviceId: "DEV1", pin: "1111", answers: allOk }, at(-2));
    await syncCheckins(db, "DEV1", at(1));
    // Engine stops at 30. Jane's break allowance runs out, then the engine restarts with nobody checking in.
    await db.update(engineSessions).set({ endedAt: at(30), lastSeenAt: at(30) });
    const restart = 30 + CHECKIN_RULES.breakMinutes.web + 10;
    await db.insert(engineSessions).values({ deviceId: "DEV1", startedAt: at(restart), lastSeenAt: at(restart + grace + 1) });
    await syncCheckins(db, "DEV1", at(restart + grace + 1));
    expect(await checkUnauthorizedUse(db, "DEV1", at(restart + grace + 1))).toHaveLength(1);
  });

  it("doesn't alert when the same operator restarts after a short break", async () => {
    await checkIn(db, { deviceId: "DEV1", pin: "1111", answers: allOk }, at(-2));
    await syncCheckins(db, "DEV1", at(1));
    await db.update(engineSessions).set({ endedAt: at(30), lastSeenAt: at(30) });
    await db.insert(engineSessions).values({ deviceId: "DEV1", startedAt: at(45), lastSeenAt: at(45 + grace + 1) });
    await syncCheckins(db, "DEV1", at(45 + grace + 1));
    expect(await checkUnauthorizedUse(db, "DEV1", at(45 + grace + 1))).toHaveLength(0);
  });

  it("only applies to armed Safety & Access Monitoring machines with the engine running", async () => {
    await db.update(devices).set({ tier: "gps" });
    expect(await checkUnauthorizedUse(db, "DEV1", at(30))).toHaveLength(0);
    await db.update(devices).set({ tier: "monitor", disarmed: true });
    expect(await checkUnauthorizedUse(db, "DEV1", at(30))).toHaveLength(0);
    await db.update(devices).set({ disarmed: false, engineOn: false });
    expect(await checkUnauthorizedUse(db, "DEV1", at(30))).toHaveLength(0);
  });

  it("re-arms automatically when a timed disarm runs out", async () => {
    await db.update(devices).set({ disarmed: true, disarmedUntil: at(20) });
    expect(await checkUnauthorizedUse(db, "DEV1", at(15))).toHaveLength(0);
    expect(await checkUnauthorizedUse(db, "DEV1", at(25))).toHaveLength(1);
  });
});

describe("isArmed", () => {
  it("handles indefinite and timed disarms", () => {
    expect(isArmed({ disarmed: false, disarmedUntil: null })).toBe(true);
    expect(isArmed({ disarmed: true, disarmedUntil: null })).toBe(false);
    expect(isArmed({ disarmed: true, disarmedUntil: at(10) }, at(5).getTime())).toBe(false);
    expect(isArmed({ disarmed: true, disarmedUntil: at(10) }, at(11).getTime())).toBe(true);
  });
});

describe("check-in alerts", () => {
  it("raises one alert per problem, once", async () => {
    const other = await createOperator(db, { name: "Bob", pin: "2222" });
    await setMachineOperators(db, "DEV1", [other.id]);
    const result = await checkIn(db, {
      deviceId: "DEV1",
      pin: "1111",
      answers: { ...allOk, seatbelt: false },
      notes: "buckle broken",
      phoneLocation: { lat: 43.7, lng: -79.4, accuracyM: 10 },
    });
    if (!result.ok) throw new Error("check-in failed");
    const raised = await raiseCheckinAlerts(db, result.checkinId);
    expect(raised.map((a) => a.type).sort()).toEqual(["checklist-failed", "not-approved", "not-at-machine"]);
    expect(raised.find((a) => a.type === "checklist-failed")!.detail).toContain('Seatbelt in good condition and working. Notes: "buckle broken"');
    expect(raised.find((a) => a.type === "not-at-machine")!.detail).toMatch(/Jane checked in [\d.]+ km away/);
    expect(await raiseCheckinAlerts(db, result.checkinId)).toHaveLength(0);
  });

  it("is quiet for a clean check-in, and for machines that aren't monitored", async () => {
    const clean = await checkIn(db, { deviceId: "DEV1", pin: "1111", answers: allOk, phoneLocation: { lat: 43.65, lng: -79.38, accuracyM: 5 } });
    if (!clean.ok) throw new Error("check-in failed");
    expect(await raiseCheckinAlerts(db, clean.checkinId)).toHaveLength(0);

    await db.update(devices).set({ tier: "gps" });
    const bad = await checkIn(db, { deviceId: "DEV1", pin: "1111", answers: { ...allOk, seatbelt: false } });
    if (!bad.ok) throw new Error("check-in failed");
    expect(await raiseCheckinAlerts(db, bad.checkinId)).toHaveLength(0);
  });
});

describe("acknowledgeAlert", () => {
  it("records when and why", async () => {
    const [alert] = await checkUnauthorizedUse(db, "DEV1", at(grace + 1));
    await acknowledgeAlert(db, alert.id, " Mechanic testing hydraulics ", at(30));
    const [row] = await db.select().from(alerts).where(eq(alerts.id, alert.id));
    expect(row).toMatchObject({ acknowledgedAt: at(30), ackNote: "Mechanic testing hydraulics" });
  });
});

describe("alert emails", () => {
  it("includes the details and a link to the machine", () => {
    const msg = alertEmail({ title: "Unauthorized use: Excavator 14", detail: "Engine running.", deviceId: "DEV1" }, "https://lab.example.com");
    expect(msg.subject).toBe("⚠ Unauthorized use: Excavator 14");
    expect(msg.text).toContain("Engine running.");
    expect(msg.text).toContain("https://lab.example.com/devices/DEV1");
  });

  it("marks alerts not-configured when email isn't set up", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const raised = await checkUnauthorizedUse(db, "DEV1", at(grace + 1));
    await deliverAlerts(db, raised);
    expect((await db.select().from(alerts))[0].emailStatus).toBe("not-configured");
  });

  it("sends through Resend and records failures", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("ALERT_EMAIL_TO", "craig@example.com, ops@example.com");
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const raised = await checkUnauthorizedUse(db, "DEV1", at(grace + 1));
    await deliverAlerts(db, raised);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(JSON.parse(init.body)).toMatchObject({ to: ["craig@example.com", "ops@example.com"], subject: "⚠ Unauthorized use: Excavator 14" });
    expect((await db.select().from(alerts))[0].emailStatus).toBe("sent");

    fetchMock.mockResolvedValue(new Response("invalid key", { status: 401 }));
    const [another] = await db
      .insert(alerts)
      .values({ deviceId: "DEV1", type: "not-approved", title: "t", createdAt: at(1) })
      .returning();
    await deliverAlerts(db, [another]);
    const [failed] = await db.select().from(alerts).where(eq(alerts.id, another.id));
    expect(failed).toMatchObject({ emailStatus: "failed", emailError: "Resend 401: invalid key" });
  });
});
