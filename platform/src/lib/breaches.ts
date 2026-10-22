import { desc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { breachRecords } from "@/lib/db/schema";

/**
 * The privacy breach register (Veristart staff; docs/privacy-canada.md). PIPEDA: keep a record of every breach
 * of security safeguards involving personal information for at least 24 months. If there's a real risk of
 * significant harm, report it to the Privacy Commissioner and notify the people affected (and tell the
 * customers whose data it was) as soon as feasible. Records are never deleted by the retention clean-up.
 */
export const BREACH_RULES = { keepMonths: 24 };

export class BreachError extends Error {}

export type BreachInput = {
  occurredAt: string;
  discoveredAt: string;
  description: string;
  dataInvolved: string;
  organizationsAffected: string;
  peopleAffected: string;
  /** "yes", "no" or "" (not assessed yet). */
  realRisk: string;
  riskReasoning: string;
  reportedToCommissionerAt: string;
  individualsNotifiedAt: string;
  customersNotifiedAt: string;
  actionsTaken: string;
  closed: boolean;
};

/** "YYYY-MM-DD" (a date picker) → that date at noon UTC, so it shows as the same day in Canada; "" → null. */
function date(value: string, label: string, required = false): Date | null {
  const v = value.trim();
  if (!v) {
    if (required) throw new BreachError(`Enter ${label}.`);
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T12:00:00Z`))) throw new BreachError(`Check ${label}.`);
  return new Date(`${v}T12:00:00Z`);
}
const text = (v: string, max = 4000) => v.trim().slice(0, max) || null;

function clean(input: BreachInput, now: Date) {
  const description = text(input.description);
  if (!description) throw new BreachError("Describe what happened.");
  const people = input.peopleAffected.trim();
  const peopleAffected = people ? Number(people) : null;
  if (peopleAffected !== null && (!Number.isInteger(peopleAffected) || peopleAffected < 0)) throw new BreachError("People affected must be a whole number.");
  const realRisk = input.realRisk === "yes" ? true : input.realRisk === "no" ? false : null;
  const values = {
    occurredAt: date(input.occurredAt, "when it happened"),
    discoveredAt: date(input.discoveredAt, "when it was discovered", true)!,
    description,
    dataInvolved: text(input.dataInvolved),
    organizationsAffected: text(input.organizationsAffected, 1000),
    peopleAffected,
    realRiskOfSignificantHarm: realRisk,
    riskReasoning: text(input.riskReasoning),
    reportedToCommissionerAt: date(input.reportedToCommissionerAt, "when it was reported to the Commissioner"),
    individualsNotifiedAt: date(input.individualsNotifiedAt, "when people were notified"),
    customersNotifiedAt: date(input.customersNotifiedAt, "when customers were told"),
    actionsTaken: text(input.actionsTaken),
    updatedAt: now,
  };
  if (values.occurredAt && values.occurredAt > values.discoveredAt) throw new BreachError("It can't have happened after it was discovered.");
  if (input.closed && realRisk === null) throw new BreachError("Assess the risk of significant harm before closing the record.");
  if (input.closed && realRisk && (!values.reportedToCommissionerAt || !values.individualsNotifiedAt)) {
    throw new BreachError("With a real risk of significant harm, record when it was reported to the Commissioner and when people were notified before closing.");
  }
  return values;
}

export async function recordBreach(db: Db, input: BreachInput, recordedBy: string, now = new Date()) {
  const values = clean(input, now);
  const [row] = await db
    .insert(breachRecords)
    .values({ ...values, closedAt: input.closed ? now : null, recordedBy, createdAt: now })
    .returning();
  return row;
}

export async function updateBreach(db: Db, id: number, input: BreachInput, now = new Date()) {
  const [existing] = await db.select().from(breachRecords).where(eq(breachRecords.id, id));
  if (!existing) throw new BreachError("Record not found.");
  const values = clean(input, now);
  await db
    .update(breachRecords)
    .set({ ...values, closedAt: input.closed ? (existing.closedAt ?? now) : null })
    .where(eq(breachRecords.id, id));
}

/** Every record, newest first, with what's still to do. */
export async function listBreaches(db: Db) {
  const rows = await db.select().from(breachRecords).orderBy(desc(breachRecords.discoveredAt), desc(breachRecords.id));
  return rows.map((b) => ({ ...b, todo: breachTodo(b) }));
}

/** What's still outstanding on a record, in plain words. */
export function breachTodo(b: typeof breachRecords.$inferSelect): string[] {
  if (b.closedAt) return [];
  const todo: string[] = [];
  if (b.realRiskOfSignificantHarm === null) todo.push("Assess the risk of significant harm");
  if (b.realRiskOfSignificantHarm) {
    if (!b.reportedToCommissionerAt) todo.push("Report to the Privacy Commissioner");
    if (!b.individualsNotifiedAt) todo.push("Notify the people affected");
    if (!b.customersNotifiedAt) todo.push("Tell the customers whose data it was");
  }
  if (!b.actionsTaken) todo.push("Record what was done to contain it");
  return todo;
}
