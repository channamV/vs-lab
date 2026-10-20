import { getDb } from "@/lib/db";
import { hasRole } from "@/lib/auth";
import { exportOperator, logAudit, PrivacyError } from "@/lib/privacy";
import { getAuth } from "@/lib/session";

/**
 * Everything stored about an operator, as a JSON file (for an operator's request to see their data).
 * Managers and owners who see the whole organization only. Recorded in the access log.
 */
export async function GET(_request: Request, { params }: RouteContext<"/operators/[id]/export">) {
  const auth = await getAuth();
  if (!auth) return new Response("Sign in first.", { status: 401 });
  if (!hasRole(auth, "manager") || auth.divisionIds !== null) return new Response("Not allowed", { status: 403 });
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return new Response("Not found", { status: 404 });
  const db = getDb();
  try {
    const data = await exportOperator(db, auth.organizationId, id);
    await logAudit(db, {
      organizationId: auth.organizationId,
      actor: auth.email,
      staff: auth.isPlatformAdmin,
      action: "operator-export",
      detail: `${data.operator.name} (#${id})`,
    });
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="operator-${id}-data.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof PrivacyError) return new Response(err.message, { status: 404 });
    throw err;
  }
}
