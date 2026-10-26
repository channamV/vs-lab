import { getDb } from "@/lib/db";
import { json, withApp } from "@/lib/app-api";
import { signOutApp } from "@/lib/operator-app";

export async function POST(request: Request) {
  return withApp(request, async (auth) => {
    await signOutApp(getDb(), auth);
    return json({ ok: true });
  });
}
