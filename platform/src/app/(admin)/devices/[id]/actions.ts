"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { getDb } from "@/lib/db";
import { devices, tierEnum } from "@/lib/db/schema";
import { endCheckin, setMachineOperators } from "@/lib/operators";

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
