import Link from "next/link";
import { Suspense } from "react";
import { currentUser, listOrganizationsForSwitcher, openAlertCountIfSignedIn } from "@/lib/data";
import { hasRole } from "@/lib/auth";
import { signOutAction } from "./login/actions";
import { switchOrganizationAction } from "./platform/actions";

/** Fleet manager pages: navigation bar on top. (Operator check-in pages have their own layout.) */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="bg-slate-900 text-white">
        <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            VS <span className="text-sky-400">Lab</span>
          </Link>
          <Suspense>
            <NavLinks />
          </Suspense>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
    </>
  );
}

const linkClass = "text-sm text-slate-300 hover:text-white";

async function NavLinks() {
  const auth = await currentUser();
  if (!auth) return null; // sign-in pages
  const [alertCount, orgs] = await Promise.all([
    openAlertCountIfSignedIn(),
    auth.isPlatformAdmin ? listOrganizationsForSwitcher() : Promise.resolve([]),
  ]);
  return (
    <>
      <Link href="/" className={linkClass}>
        Fleet
      </Link>
      <Link href="/operators" className={linkClass}>
        Operators
      </Link>
      {hasRole(auth, "manager") && (
        <Link href="/checklists" className={linkClass}>
          Checklists
        </Link>
      )}
      <Link href="/alerts" className={`flex items-center gap-1.5 ${linkClass}`}>
        Alerts
        {!!alertCount && <span className="rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white">{alertCount}</span>}
      </Link>
      {hasRole(auth, "owner") && (
        <>
          <Link href="/users" className={linkClass}>
            Users
          </Link>
          <Link href="/settings" className={linkClass}>
            Settings
          </Link>
        </>
      )}
      {auth.isPlatformAdmin && (
        <Link href="/platform" className={linkClass}>
          Platform
        </Link>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-3 text-sm text-slate-300">
        {auth.isPlatformAdmin ? (
          <form action={switchOrganizationAction} className="flex items-center gap-1">
            <label htmlFor="org-switch" className="sr-only">
              Organization
            </label>
            <select
              id="org-switch"
              name="organizationId"
              defaultValue={auth.organizationId}
              className="rounded bg-slate-800 px-2 py-1 text-white"
            >
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <button className="rounded border border-slate-600 px-2 py-1 hover:bg-slate-800">View</button>
          </form>
        ) : (
          <span className="font-medium text-white">{auth.organizationName}</span>
        )}
        <span className="hidden sm:inline">{auth.email}</span>
        <form action={signOutAction}>
          <button className="hover:text-white">Sign out</button>
        </form>
      </div>
    </>
  );
}
