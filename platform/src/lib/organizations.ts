import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { organizations, users, type Role } from "@/lib/db/schema";
import { normalizeEmail } from "@/lib/auth";
import { addDefaultSubscriptions } from "@/lib/subscriptions";

/**
 * Organizations and their users. (Machines and devices: src/lib/machines.ts.)
 * Plain functions that take the database, so they can be tested without a server.
 */

export class AccountError extends Error {}

export async function createOrganization(db: Db, rawName: string) {
  const name = rawName.trim();
  if (!name) throw new AccountError("Enter the organization's name.");
  const [org] = await db.insert(organizations).values({ name }).returning();
  return org;
}

/**
 * Adds a person to an organization. One organization per email address: if the address already has
 * an account anywhere, they can't be added again.
 */
export async function addUser(db: Db, organizationId: number, input: { email: string; name?: string; role: Role }) {
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AccountError("Enter a valid email address.");
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) {
    throw new AccountError(
      existing.organizationId === organizationId
        ? `${email} is already a user here.`
        : `${email} already belongs to another organization. Each person can be in one organization.`,
    );
  }
  const [user] = await db
    .insert(users)
    .values({ organizationId, email, name: input.name?.trim() || null, role: input.role })
    .returning();
  await addDefaultSubscriptions(db, user.id, user.role);
  return user;
}

/** Changes someone's role or turns their access off. An organization always keeps an active owner. */
export async function updateUser(
  db: Db,
  organizationId: number,
  userId: number,
  input: { role: Role; active: boolean; name?: string },
) {
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), eq(users.organizationId, organizationId)));
  if (!user) throw new AccountError("User not found.");
  const losingOwner = user.role === "owner" && user.active && (input.role !== "owner" || !input.active);
  if (losingOwner) {
    const others = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(eq(users.organizationId, organizationId), eq(users.role, "owner"), eq(users.active, true), ne(users.id, userId)),
      );
    if (others.length === 0) throw new AccountError("Every organization needs at least one active owner.");
  }
  await db
    .update(users)
    .set({ role: input.role, active: input.active, name: input.name?.trim() || null })
    .where(eq(users.id, userId));
}
