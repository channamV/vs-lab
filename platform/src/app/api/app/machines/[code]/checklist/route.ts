import { getDb } from "@/lib/db";
import { fail, json, withApp } from "@/lib/app-api";
import { appChecklist } from "@/lib/operator-app";

/** GET: the machine's pre-start checklist (questions, answers, meter reading, town) as the QR page shows it. */
export async function GET(request: Request, ctx: RouteContext<"/api/app/machines/[code]/checklist">) {
  return withApp(request, async (auth) => {
    const data = await appChecklist(getDb(), auth, decodeURIComponent((await ctx.params).code));
    return data ? json(data) : fail("Machine not found.", 404);
  });
}
