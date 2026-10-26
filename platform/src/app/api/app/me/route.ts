import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { json, withApp } from "@/lib/app-api";
import { appMachines } from "@/lib/operator-app";

/** GET: who's signed in, their company, and their machines (home screen). */
export async function GET(request: Request) {
  return withApp(request, async (auth) => {
    const db = getDb();
    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, auth.organizationId));
    return json({ operator: { id: auth.operatorId, name: auth.operatorName }, organization: { name: org?.name ?? "" }, machines: await appMachines(db, auth) });
  });
}
