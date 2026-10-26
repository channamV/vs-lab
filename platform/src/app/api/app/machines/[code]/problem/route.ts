import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { machines } from "@/lib/db/schema";
import { fail, json, withApp } from "@/lib/app-api";
import { addAttachment, createManualIssue, MaintenanceError } from "@/lib/maintenance";
import { MAINTENANCE_RULES } from "@/lib/maintenance-types";
import { photoStorageAvailable, saveDocument } from "@/lib/photos";

/** POST (multipart: title, description, photo files): an operator reports a problem → a maintenance item (Minor). */
export async function POST(request: Request, ctx: RouteContext<"/api/app/machines/[code]/problem">) {
  return withApp(request, async (auth) => {
    const db = getDb();
    const code = decodeURIComponent((await ctx.params).code).slice(0, 32);
    const [m] = await db.select({ id: machines.id }).from(machines).where(and(eq(machines.code, code), eq(machines.organizationId, auth.organizationId)));
    if (!m) return fail("Machine not found.", 404);
    const form = await request.formData().catch(() => null);
    if (!form) return fail("Couldn't read the report.");
    try {
      const issue = await createManualIssue(db, auth.organizationId, null, {
        machineId: m.id,
        title: String(form.get("title") ?? ""),
        priority: "minor",
        complaint: String(form.get("description") ?? ""),
        reportedBy: auth.operatorName,
      });
      const files = form.getAll("photo").filter((f): f is File => f instanceof File && f.size > 0).slice(0, 3);
      if (files.length && photoStorageAvailable()) {
        for (const f of files) {
          if (!MAINTENANCE_RULES.attachmentTypes.includes(f.type) || f.size > MAINTENANCE_RULES.attachmentMaxBytes) continue;
          const key = await saveDocument(auth.organizationId, new Uint8Array(await f.arrayBuffer()), f.type);
          await addAttachment(db, auth.organizationId, issue.id, null, { section: "complaint", storageKey: key, filename: f.name || "photo.jpg", contentType: f.type, bytes: f.size });
        }
      }
      return json({ ok: true, number: issue.number });
    } catch (e) {
      if (e instanceof MaintenanceError) return fail(e.message);
      throw e;
    }
  });
}
