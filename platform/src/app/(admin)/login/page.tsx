import { Suspense } from "react";
import { authMisconfigured } from "@/lib/auth";
import { LoginForm } from "./LoginForm";

export default function LoginPage() {
  return (
    <div className="mx-auto mt-16 max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
      <h1 className="text-xl font-semibold">Sign in</h1>
      {authMisconfigured() ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Sign-in isn&apos;t set up yet. Add <code>ADMIN_PASSWORD</code> in Vercel → Settings →
          Environment Variables, then redeploy. The site stays locked until then.
        </p>
      ) : (
        <Suspense>
          <LoginForm />
        </Suspense>
      )}
    </div>
  );
}
