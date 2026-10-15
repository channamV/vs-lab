"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";
import { isValidSession, SESSION_COOKIE } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { devices, tierEnum } from "@/lib/db/schema";

const UpdateDevice = z.object({
  id: z.string().min(1).max(32),
  name: z.string().trim().max(80),
  tier: z.enum(tierEnum.enumValues),
});

export async function updateDevice(formData: FormData) {
  const store = await cookies();
  if (!(await isValidSession(store.get(SESSION_COOKIE)?.value))) throw new Error("Not signed in");

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
