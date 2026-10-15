"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { getDb } from "@/lib/db";
import { devices, tierEnum } from "@/lib/db/schema";
import { endCheckin, setMachineOperators } from "@/lib/operators";
import { appTimeZone, startOfLocalDay } from "@/lib/telemetry/engine";

const UpdateDevice = z.object({
  id: z.string().min(1).max(32),
  name: z.string().trim().max(80),
  tier: z.enum(tierEnum.enumValues),
});

export async function updateDevice(formData: FormData) {
  await requireAdmin();
  const input = UpdateDevice.parse({
    id: formData.get("id"),
    name: formData.get("name") ?? "",
    tier: formData.get("tier"),
  });
  await getDb()
    .update(devices)
    .set({ name: input.name || null, tier: input.tier })
    .where(eq(devices.id, input.id));
  refresh();
}

const AllowedOperators = z.object({
  id: z.string().min(1).max(32),
  operatorIds: z.array(z.coerce.number().int().positive()),
});

export async function setAllowedOperators(formData: FormData) {
  await requireAdmin();
  const input = AllowedOperators.parse({ id: formData.get("id"), operatorIds: formData.getAll("operator") });
  await setMachineOperators(getDb(), input.id, input.operatorIds);
  refresh();
}

export async function endCheckinAction(formData: FormData) {
  await requireAdmin();
  const checkinId = z.coerce.number().int().positive().parse(formData.get("checkinId"));
  await endCheckin(getDb(), checkinId);
  refresh();
}

const Arming = z.object({
  id: z.string().min(1).max(32),
  mode: z.enum(["arm", "1h", "4h", "morning", "indefinite"]),
});

/** Arm, or disarm for a while (e.g. during a service visit). Timed disarms re-arm themselves. */
export async function setArming(formData: FormData) {
  await requireAdmin();
  const { id, mode } = Arming.parse({ id: formData.get("id"), mode: formData.get("mode") });
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
    .update(devices)
    .set({ disarmed: mode !== "arm", disarmedUntil: until })
    .where(eq(devices.id, id));
  refresh();
}
