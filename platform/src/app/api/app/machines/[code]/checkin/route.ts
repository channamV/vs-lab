import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { machines } from "@/lib/db/schema";
import { afterCheckin } from "@/lib/alert-jobs";
import { fail, json, withApp } from "@/lib/app-api";
import { CHECKIN_MESSAGES } from "@/lib/checkin-messages";
import { CHECKIN_RULES, checkIn } from "@/lib/operators";
import { passForCheckin, replaceAppStart } from "@/lib/operator-app";
import type { PhotoFile } from "@/lib/photos";

/**
 * POST (multipart form, the same fields as the QR page: item:<q>, note:<q>, notes, confirmed, lockout, skipChecklist,
 * meterReading, photo:<q> files, phoneLat/phoneLng/phoneAccuracy) plus completedAt (ISO time) when the checklist was
 * done without signal. Checks the signed-in operator in; on a Safety & Access Control machine the answer includes the
 * pass to write to the machine over Bluetooth.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/app/machines/[code]/checkin">) {
  return withApp(request, async (auth) => {
    const db = getDb();
    const code = decodeURIComponent((await ctx.params).code).slice(0, 32);
    const form = await request.formData().catch(() => null);
    if (!form) return fail("Couldn't read the check-in.");
    const answers: Record<string, string> = {};
    const answerNotes: Record<string, string> = {};
    const photos: PhotoFile[] = [];
    for (const [key, value] of form.entries()) {
      if (key.startsWith("photo:") && typeof value !== "string" && photos.length < 40) {
        photos.push({ questionId: key.slice(6, 46), data: new Uint8Array(await value.arrayBuffer()), contentType: value.type });
        continue;
      }
      if (typeof value !== "string" || value.length > 500) continue;
      if (key.startsWith("item:")) answers[key.slice(5, 45)] = value.slice(0, 40);
      if (key.startsWith("note:")) answerNotes[key.slice(5, 45)] = value;
    }
    const num = (k: string) => (form.get(k) ? Number(form.get(k)) : NaN);
    const lat = num("phoneLat");
    const lng = num("phoneLng");
    const completed = form.get("completedAt") ? new Date(String(form.get("completedAt"))) : null;
    const startedAt = completed && !Number.isNaN(completed.getTime()) ? completed : undefined;
    // Done without signal and already started with an offline pass: the device's report of that start is replaced.
    if (startedAt) {
      const [m] = await db.select({ id: machines.id }).from(machines).where(and(eq(machines.code, code), eq(machines.organizationId, auth.organizationId)));
      if (m) await replaceAppStart(db, auth, m.id, startedAt);
    }
    const result = await checkIn(db, {
      machineCode: code,
      pin: "",
      operatorId: auth.operatorId,
      method: "app",
      startedAt,
      answers,
      answerNotes,
      notes: String(form.get("notes") ?? "").slice(0, 1000),
      confirmed: form.get("confirmed") === "on" || form.get("confirmed") === "true",
      lockout: form.get("lockout") === "yes",
      skipChecklist: form.get("skipChecklist") === "on" || form.get("skipChecklist") === "true",
      photos,
      phoneLocation:
        Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
          ? { lat, lng, accuracyM: Math.min(100_000, Math.max(0, num("phoneAccuracy") || 0)) }
          : null,
      meterReading: String(form.get("meterReading") ?? "").slice(0, 20),
    });
    if (!result.ok) {
      const reason = result.reason === "bad-pin" ? "You can't check in on this machine (account inactive or another company's machine)." : CHECKIN_MESSAGES[result.reason];
      return json({ ok: false, reason: result.reason, message: reason + (result.questions?.length ? ` ${result.questions.slice(0, 3).join("; ")}` : "") }, 422);
    }
    afterCheckin(result.checkinId);
    return json({ ...result, startWindowMinutes: CHECKIN_RULES.engineStartWindowMinutes, unlock: await passForCheckin(db, result.checkinId) });
  });
}
