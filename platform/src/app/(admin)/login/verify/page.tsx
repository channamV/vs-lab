import { Suspense } from "react";
import { VerifyForm } from "../LoginForm";

/** Opened from the emailed link. Signing in happens when the button is pressed (see verifyLinkAction). */
export default function VerifyPage() {
  return (
    <div className="mx-auto mt-16 max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <Suspense>
        <VerifyForm />
      </Suspense>
    </div>
  );
}
