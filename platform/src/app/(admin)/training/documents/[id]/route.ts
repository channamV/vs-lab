import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { trainingRecords } from "@/lib/db/schema";
import { readPhoto } from "@/lib/photos";
import { getAuth } from "@/lib/session";

/** A training record's certificate (photo or PDF), for signed-in users of the same company. Stored privately. */
export async function GET(_request: Request, { params }: RouteContext<"/training/documents/[id]">) {
  const auth = await getAuth();
  if (!auth) return new Response("Sign in to see certificates.", { status: 401 });
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return new Response("Not found", { status: 404 });
  const [row] = await getDb()
    .select({ key: trainingRecords.documentKey, type: trainingRecords.documentType })
    .from(trainingRecords)
    .where(and(eq(trainingRecords.id, id), eq(trainingRecords.organizationId, auth.organizationId)));
  if (!row?.key) return new Response("Not found", { status: 404 });
  const body = await readPhoto(row.key);
  if (!body) return new Response("Certificate missing", { status: 404 });
  return new Response(body as BodyInit, {
    headers: {
      "Content-Type": row.type ?? "application/octet-stream",
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
