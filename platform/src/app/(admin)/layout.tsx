import Link from "next/link";
import { Suspense } from "react";
import { openAlertCountIfSignedIn } from "@/lib/data";

/** Fleet manager pages: navigation bar on top. (Operator check-in pages have their own layout.) */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="bg-slate-900 text-white">
        <nav className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            VS <span className="text-sky-400">Lab</span>
          </Link>
          <Link href="/" className="text-sm text-slate-300 hover:text-white">
            Fleet
          </Link>
          <Link href="/operators" className="text-sm text-slate-300 hover:text-white">
            Operators
          </Link>
          <Link href="/alerts" className="flex items-center gap-1.5 text-sm text-slate-300 hover:text-white">
            Alerts
            <Suspense>
              <OpenAlertBadge />
            </Suspense>
          </Link>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
    </>
  );
}

async function OpenAlertBadge() {
  const count = await openAlertCountIfSignedIn();
  if (!count) return null;
  return <span className="rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white">{count}</span>;
}
