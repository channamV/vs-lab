import { Suspense } from "react";
import { EmailLinkForm } from "./LoginForm";

export default function LoginPage() {
  return (
    <div className="mx-auto mt-16 max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <p className="text-sm text-slate-500">Enter your email and we&apos;ll send you a link. No password needed.</p>
      <Suspense>
        <EmailLinkForm />
      </Suspense>
    </div>
  );
}
