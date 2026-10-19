"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/lib/session";
import { getDb } from "@/lib/db";
import { machines } from "@/lib/db/schema";
import { endCheckin, setMachineOperators } from "@/lib/operators";
import { assertCheckinInScope, assertMachineInScope } from "@/lib/divisions";
import { appTimeZone, startOfLocalDay } from "@/lib/telemetry/engine";

const AllowedOperators = z.object({
  id: z.coerce.number().int().positive(),
  operatorIds: z.array(z.coerce.number().int().positive()),
});

export async function setAllowedOperators(formData: FormData) {
  const auth = await requireAuth("manager");
  const input = AllowedOperators.parse({ id: formData.get("id"), operatorIds: formData.getAll("operator") });
  await assertMachineInScope(getDb(), auth, input.id);
  await setMachineOperators(getDb(), auth.organizationId, input.id, input.operatorIds);
  refresh();
}

export async function endCheckinAction(formData: FormData) {
  const auth = await requireAuth("manager");
  const checkinId = z.coerce.number().int().positive().parse(formData.get("checkinId"));
  await assertCheckinInScope(getDb(), auth, checkinId);
  await endCheckin(getDb(), auth.organizationId, checkinId);
  refresh();
}

const Arming = z.object({
  id: z.coerce.number().int().positive(),
  mode: z.enum(["arm", "1h", "4h", "morning", "indefinite"]),
});

/** Arm, or disarm for a while (e.g. during a service visit). Timed disarms re-arm themselves. */
export async function setArming(formData: FormData) {
  const auth = await requireAuth("manager");
  const { id, mode } = Arming.parse({ id: formData.get("id"), mode: formData.get("mode") });
  await assertMachineInScope(getDb(), auth, id);
  const now = Date.now();
  const until = {
    arm: null,
    indefinite: null,
    "1h": new Date(now + 3_600_000),
    "4h": new Date(now + 4 * 3_600_000),
    // 6 am tomorrow, local time
    morning: new Date(startOfLocalDay(now, appTimeZone(), -1) + 6 * 3_600_000),
  }[mode];
  await getDb()
    .update(machines)
    .set({ disarmed: mode !== "arm", disarmedUntil: until })
    .where(and(eq(machines.id, id), eq(machines.organizationId, auth.organizationId)));
  refresh();
}
