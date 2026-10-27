import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, eq, gt, gte, isNull } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { addDefaultRule } from "@/lib/notifications";
import { divisions, loginTokens, organizations, sessions, userDivisions, users, type Role } from "@/lib/db/schema";
import { logAudit } from "@/lib/privacy";

/**
 * Sign-in for the portal: people enter their email and get a one-time link (no passwords to manage).
 * Plain functions that take the database, so they can be tested without a server. The cookie and
 * page side is in src/lib/session.ts.
 *
 * Platform admins (Veristart staff) are the emails in PLATFORM_ADMIN_EMAILS. They can look at any
 * organization. The first time one signs in, they get a user in the first organization as owner.
 */

export const SESSION_COOKIE = "vslab_session";

export const AUTH_RULES = {
  /** How long a sign-in link works. */
  linkMinutes: 15,
  /** How long a browser stays signed in. */
  sessionDays: 30,
  /** Sign-in links per email address per hour (stops someone flooding an inbox). */
  maxLinksPerHour: 5,
};

export const ROLE_RANK: Record<Role, number> = { viewer: 1, manager: 2, owner: 3 };

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function platformAdminEmails(): string[] {
  return (process.env.PLATFORM_ADMIN_EMAILS ?? "").split(",").map(normalizeEmail).filter(Boolean);
}

export function isPlatformAdminEmail(email: string): boolean {
  return platformAdminEmails().includes(normalizeEmail(email));
}

/** Tokens are random; only their SHA-256 is stored, so a database leak can't be used to sign in. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** A platform admin signing in for the first time gets a user in the first organization (created if needed). */
async function ensurePlatformAdminUser(db: Db, email: string) {
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) return existing;
  let [org] = await db.select().from(organizations).orderBy(asc(organizations.id)).limit(1);
  if (!org) [org] = await db.insert(organizations).values({ name: "Veristart Lab" }).returning();
  const [user] = await db.insert(users).values({ organizationId: org.id, email, role: "owner" }).returning();
  await addDefaultRule(db, user);
  return user;
}

/**
 * Creates a one-time sign-in link token for an active user. Returns null if the email has no account
 * or has asked for too many links; the page shows the same message either way, so it can't be used to
 * find out who has an account.
 */
export async function requestSignInLink(db: Db, rawEmail: string, now = new Date()): Promise<string | null> {
  const email = normalizeEmail(rawEmail);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  if (isPlatformAdminEmail(email)) await ensurePlatformAdminUser(db, email);
  const [user] = await db.select().from(users).where(and(eq(users.email, email), eq(users.active, true)));
  if (!user) return null;

  const [{ recent }] = await db
    .select({ recent: count() })
    .from(loginTokens)
    .where(and(eq(loginTokens.email, email), gte(loginTokens.createdAt, new Date(now.getTime() - 3_600_000))));
  if (recent >= AUTH_RULES.maxLinksPerHour) return null;

  const token = newToken();
  await db.insert(loginTokens).values({
    email,
    tokenHash: hashToken(token),
    createdAt: now,
    expiresAt: new Date(now.getTime() + AUTH_RULES.linkMinutes * 60_000),
  });
  return token;
}

async function startSession(db: Db, userId: number, now: Date) {
  const token = newToken();
  const expiresAt = new Date(now.getTime() + AUTH_RULES.sessionDays * 86_400_000);
  await db.insert(sessions).values({ tokenHash: hashToken(token), userId, createdAt: now, expiresAt });
  await db.update(users).set({ lastSignInAt: now }).where(eq(users.id, userId));
  return { token, expiresAt };
}

/** Uses a sign-in link (once). Returns a new session token for the cookie, or null if the link is invalid. */
export async function redeemSignInLink(db: Db, token: string, now = new Date()) {
  const [link] = await db
    .update(loginTokens)
    .set({ usedAt: now })
    .where(and(eq(loginTokens.tokenHash, hashToken(token)), isNull(loginTokens.usedAt), gt(loginTokens.expiresAt, now)))
    .returning();
  if (!link) return null;
  const [user] = await db.select().from(users).where(and(eq(users.email, link.email), eq(users.active, true)));
  if (!user) return null;
  return startSession(db, user.id, now);
}

export type AuthContext = {
  sessionId: number;
  userId: number;
  email: string;
  name: string | null;
  role: Role;
  isPlatformAdmin: boolean;
  /** The user's own organization. */
  homeOrganizationId: number;
  /** The organization being viewed: their own, or (platform admins) the one they switched to. */
  organizationId: number;
  organizationName: string;
  /** The organization's time zone (Settings): every time and day shown to this user is in it. */
  timeZone: string;
  /**
   * The divisions this user is limited to, or null for the whole organization (owners, platform admins
   * and users with no divisions ticked). See src/lib/divisions.ts.
   */
  divisionIds: number[] | null;
};

/** Looks up a session cookie. Null if missing, expired, or the user has been deactivated. */
export async function authFromToken(db: Db, token: string | undefined, now = new Date()): Promise<AuthContext | null> {
  if (!token) return null;
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, now), eq(users.active, true)));
  if (!row) return null;
  const isPlatformAdmin = isPlatformAdminEmail(row.user.email);
  const organizationId = (isPlatformAdmin && row.session.viewOrganizationId) || row.user.organizationId;
  const [org] = await db.select().from(organizations).where(eq(organizations.id, organizationId));
  if (!org) return null;
  const role = isPlatformAdmin ? "owner" : row.user.role;
  const limitedTo =
    role === "owner"
      ? []
      : await db
          .select({ id: userDivisions.divisionId })
          .from(userDivisions)
          .innerJoin(divisions, eq(divisions.id, userDivisions.divisionId))
          .where(and(eq(userDivisions.userId, row.user.id), eq(divisions.organizationId, org.id)));
  return {
    sessionId: row.session.id,
    userId: row.user.id,
    email: row.user.email,
    name: row.user.name,
    // Platform admins can do everything in whichever organization they're viewing.
    role,
    isPlatformAdmin,
    homeOrganizationId: row.user.organizationId,
    organizationId: org.id,
    organizationName: org.name,
    timeZone: org.timezone,
    divisionIds: limitedTo.length ? limitedTo.map((d) => d.id) : null,
  };
}

export function hasRole(auth: Pick<AuthContext, "role">, minimum: Role): boolean {
  return ROLE_RANK[auth.role] >= ROLE_RANK[minimum];
}

export async function endSession(db: Db, token: string) {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

/** Platform admins only: switch which organization this browser is looking at. */
export async function viewOrganization(db: Db, auth: AuthContext, organizationId: number) {
  if (!auth.isPlatformAdmin) throw new Error("Not allowed");
  await db.update(sessions).set({ viewOrganizationId: organizationId }).where(eq(sessions.id, auth.sessionId));
  // Customers can see when Veristart staff looked at their organization (Settings → access log).
  if (organizationId !== auth.homeOrganizationId && organizationId !== auth.organizationId) {
    await logAudit(db, { organizationId, actor: auth.email, staff: true, action: "staff-view", detail: "Opened the organization" });
  }
}
