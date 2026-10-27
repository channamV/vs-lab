import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { organizations, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  AUTH_RULES,
  authFromToken,
  endSession,
  hasRole,
  redeemSignInLink,
  requestSignInLink,
  viewOrganization,
} from "./auth";

let db: Db;
let orgA: number;
let orgB: number;
const t0 = new Date("2026-10-18T12:00:00Z");
const at = (min: number) => new Date(t0.getTime() + min * 60_000);

beforeEach(async () => {
  db = createDb();
  await migrateDb(db, false); // creates "Veristart Lab" (the first organization)
  [{ id: orgA }] = await db.insert(organizations).values({ name: "ABC Civil" }).returning();
  [{ id: orgB }] = await db.insert(organizations).values({ name: "XYZ Paving" }).returning();
  await db.insert(users).values([
    { organizationId: orgA, email: "jane@abc.com", role: "manager" },
    { organizationId: orgB, email: "bob@xyz.com", role: "viewer" },
  ]);
  vi.stubEnv("PLATFORM_ADMIN_EMAILS", "Craig@Veristart.ca");
});

afterEach(() => vi.unstubAllEnvs());

async function signIn(email: string, now = t0) {
  const token = await requestSignInLink(db, email, now);
  if (!token) throw new Error("no link");
  const session = await redeemSignInLink(db, token, now);
  if (!session) throw new Error("no session");
  return session.token;
}

describe("sign-in links", () => {
  it("signs a user in once per link", async () => {
    const token = await requestSignInLink(db, "  JANE@abc.com ", t0);
    expect(token).toBeTruthy();
    const session = await redeemSignInLink(db, token!, at(1));
    expect(session).not.toBeNull();
    expect(await redeemSignInLink(db, token!, at(2))).toBeNull(); // used
    const auth = await authFromToken(db, session!.token, at(3));
    expect(auth).toMatchObject({ email: "jane@abc.com", role: "manager", organizationId: orgA, organizationName: "ABC Civil", isPlatformAdmin: false });
  });

  it("gives nothing to unknown or deactivated emails", async () => {
    expect(await requestSignInLink(db, "stranger@nowhere.com", t0)).toBeNull();
    await db.update(users).set({ active: false }).where(eq(users.email, "jane@abc.com"));
    expect(await requestSignInLink(db, "jane@abc.com", t0)).toBeNull();
  });

  it("expires links", async () => {
    const token = await requestSignInLink(db, "jane@abc.com", t0);
    expect(await redeemSignInLink(db, token!, at(AUTH_RULES.linkMinutes + 1))).toBeNull();
  });

  it("limits how many links an address can get", async () => {
    for (let i = 0; i < AUTH_RULES.maxLinksPerHour; i++) expect(await requestSignInLink(db, "jane@abc.com", at(i))).toBeTruthy();
    expect(await requestSignInLink(db, "jane@abc.com", at(10))).toBeNull();
    expect(await requestSignInLink(db, "jane@abc.com", at(70))).toBeTruthy();
  });
});

describe("sessions", () => {
  it("end on sign-out, expiry, or deactivation", async () => {
    const a = await signIn("jane@abc.com");
    expect(await authFromToken(db, a, at(1))).not.toBeNull();
    expect(await authFromToken(db, a, new Date(t0.getTime() + (AUTH_RULES.sessionDays + 1) * 86_400_000))).toBeNull();
    await endSession(db, a);
    expect(await authFromToken(db, a, at(1))).toBeNull();

    const b = await signIn("jane@abc.com");
    await db.update(users).set({ active: false }).where(eq(users.email, "jane@abc.com"));
    expect(await authFromToken(db, b, at(1))).toBeNull();
    expect(await authFromToken(db, "made-up-token", at(1))).toBeNull();
    expect(await authFromToken(db, undefined, at(1))).toBeNull();
  });

  it("checks roles", async () => {
    const auth = await authFromToken(db, await signIn("bob@xyz.com"), at(1));
    expect(hasRole(auth!, "viewer")).toBe(true);
    expect(hasRole(auth!, "manager")).toBe(false);
  });
});

describe("platform admins", () => {
  it("get an owner account in the first organization the first time they sign in", async () => {
    const auth = await authFromToken(db, await signIn("craig@veristart.ca"), at(1));
    expect(auth).toMatchObject({ isPlatformAdmin: true, role: "owner", organizationName: "Veristart Lab" });
  });

  it("can switch the organization they're looking at; others can't", async () => {
    const token = await signIn("craig@veristart.ca");
    const admin = (await authFromToken(db, token, at(1)))!;
    await viewOrganization(db, admin, orgB);
    expect(await authFromToken(db, token, at(2))).toMatchObject({ organizationId: orgB, organizationName: "XYZ Paving", role: "owner" });

    const jane = (await authFromToken(db, await signIn("jane@abc.com"), at(1)))!;
    await expect(viewOrganization(db, jane, orgB)).rejects.toThrow();
  });
});
