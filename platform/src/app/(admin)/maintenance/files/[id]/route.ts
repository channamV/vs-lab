import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { machines, maintenanceAttachments, maintenanceIssues } from "@/lib/db/schema";
import { canSeeMachine } from "@/lib/divisions";
import { readPhoto } from "@/lib/photos";
import { getAuth } from "@/lib/session";

/** A file attached to a maintenance item, for signed-in users who can see its machine (stored privately). */
export async function GET(_request: Request, { params }: RouteContext<"/maintenance/files/[id]">) {
  const auth = await getAuth();
  if (!auth) return new Response("Sign in to see files.", { status: 401 });
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return new Response("Not found", { status: 404 });
  const [row] = await getDb()
    .select({ file: maintenanceAttachments, machine: machines })
    .from(maintenanceAttachments)
    .innerJoin(maintenanceIssues, eq(maintenanceIssues.id, maintenanceAttachments.issueId))
    .innerJoin(machines, eq(machines.id, maintenanceIssues.machineId))
    .where(and(eq(maintenanceAttachments.id, id), eq(maintenanceAttachments.organizationId, auth.organizationId)));
  if (!row || !canSeeMachine(auth, row.machine)) return new Response("Not found", { status: 404 });
  const body = await readPhoto(row.file.storageKey);
  if (!body) return new Response("File missing", { status: 404 });
  return new Response(body as BodyInit, {
    headers: {
      "Content-Type": row.file.contentType,
      "Content-Disposition": `inline; filename="${row.file.filename.replace(/[^\w.\- ]/g, "_")}"`,
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
