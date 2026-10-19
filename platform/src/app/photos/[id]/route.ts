import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { checkinPhotos, machines } from "@/lib/db/schema";
import { canSeeMachine } from "@/lib/divisions";
import { readPhoto } from "@/lib/photos";
import { getAuth } from "@/lib/session";

/**
 * A checklist photo, for signed-in users who can see its machine. Photos are stored privately, so
 * this is the only way to view them.
 */
export async function GET(_request: Request, { params }: RouteContext<"/photos/[id]">) {
  const auth = await getAuth();
  if (!auth) return new Response("Sign in to see photos.", { status: 401 });
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return new Response("Not found", { status: 404 });
  const [row] = await getDb()
    .select({ photo: checkinPhotos, machine: machines })
    .from(checkinPhotos)
    .innerJoin(machines, eq(machines.id, checkinPhotos.machineId))
    .where(and(eq(checkinPhotos.id, id), eq(checkinPhotos.organizationId, auth.organizationId)));
  if (!row || !canSeeMachine(auth, row.machine)) return new Response("Not found", { status: 404 });
  const body = await readPhoto(row.photo.storageKey);
  if (!body) return new Response("Photo missing", { status: 404 });
  return new Response(body as BodyInit, {
    headers: { "Content-Type": row.photo.contentType, "Cache-Control": "private, max-age=86400" },
  });
}
