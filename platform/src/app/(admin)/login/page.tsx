import { connection } from "next/server";
import { Suspense } from "react";
import { passwordSignInAvailable } from "@/lib/auth";
import { EmailLinkForm, PasswordForm } from "./LoginForm";

export default function LoginPage() {
  return (
    <div className="mx-auto mt-16 max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <p className="text-sm text-slate-500">Enter your email and we&apos;ll send you a link. No password needed.</p>
      <Suspense>
        <EmailLinkForm />
      </Suspense>
      <Suspense>
        <PasswordOption />
      </Suspense>
    </div>
  );
}

/** Transition only. Decided when the page is opened (not when the site is built), from the settings. */
async function PasswordOption() {
  await connection();
  if (!passwordSignInAvailable()) return null;
  return (
    <details className="border-t border-slate-200 pt-3 text-sm dark:border-slate-800">
      <summary className="cursor-pointer text-slate-500">Use the admin password instead</summary>
      <div className="mt-3">
        <PasswordForm />
      </div>
    </details>
  );
}
