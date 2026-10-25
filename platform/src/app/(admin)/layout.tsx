import Link from "next/link";
import { Suspense } from "react";
import { cookies } from "next/headers";
import { AppNav, type NavGroup } from "@/components/AppNav";
import { NAV_COOKIE } from "@/lib/nav";
import { BrandLogo } from "@/components/BrandLogo";
import { currentUser, listOrganizationsForSwitcher, openAlertCountIfSignedIn } from "@/lib/data";
import { hasRole } from "@/lib/auth";

/**
 * Fleet manager pages: sidebar menu on desktop, top bar + slide-in menu on phones (src/components/AppNav.tsx).
 * Signed out (sign-in pages): just the logo. Operator check-in pages have their own layout.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 lg:has-[aside]:flex">
      <Suspense>
        <Navigation />
      </Suspense>
      <main className="mx-auto w-full max-w-6xl min-w-0 flex-1 px-4 py-6">{children}</main>
    </div>
  );
}

async function Navigation() {
  const auth = await currentUser();
  if (!auth) {
    return (
      <header className="bg-slate-900 px-4 py-3">
        <Link href="/" className="inline-block" title="Veristart Lab">
          <BrandLogo />
        </Link>
      </header>
    );
  }
  const [alertCount, orgs, cookieStore] = await Promise.all([
    openAlertCountIfSignedIn(),
    auth.isPlatformAdmin ? listOrganizationsForSwitcher() : Promise.resolve(null),
    cookies(),
  ]);
  const groups: NavGroup[] = [
    {
      label: "Operations",
      items: [
        { href: "/", label: "Fleet", icon: "fleet" },
        { href: "/worksites", label: "Worksites", icon: "worksites" },
        { href: "/schedules", label: "Schedules", icon: "schedules" },
        { href: "/alerts", label: "Alerts", icon: "alerts", badge: alertCount },
        { href: "/alerts/subscriptions", label: "Notifications", icon: "subscriptions" },
        { href: "/reports", label: "Reports", icon: "reports" },
      ],
    },
    {
      label: "Safety",
      items: [
        { href: "/operators", label: "Operators", icon: "operators" },
        { href: "/training", label: "Training", icon: "training" },
        ...(hasRole(auth, "manager") ? [{ href: "/checklists", label: "Checklists", icon: "checklists" } as const] : []),
      ],
    },
    ...(hasRole(auth, "owner")
      ? [
          {
            label: "Company",
            items: [
              { href: "/users", label: "Users", icon: "users" },
              { href: "/settings", label: "Settings", icon: "settings" },
            ],
          } satisfies NavGroup,
        ]
      : []),
    ...(auth.isPlatformAdmin
      ? [{ label: "Veristart staff", items: [{ href: "/platform", label: "Platform", icon: "platform" }] } satisfies NavGroup]
      : []),
  ];
  return (
    <AppNav
      groups={groups}
      alertCount={alertCount}
      initiallyCollapsed={cookieStore.get(NAV_COOKIE)?.value === "collapsed"}
      account={{ email: auth.email, organizationId: auth.organizationId, organizationName: auth.organizationName, organizations: orgs }}
    />
  );
}
