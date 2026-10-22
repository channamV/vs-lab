"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BarChart3,
  Bell,
  BellRing,
  Building2,
  CalendarClock,
  ChevronsLeft,
  ChevronsRight,
  ClipboardCheck,
  GraduationCap,
  HardHat,
  LogOut,
  MapPinned,
  Menu,
  Settings,
  Shield,
  Truck,
  UserCog,
  X,
  type LucideIcon,
} from "lucide-react";
import { signOutAction } from "@/app/(admin)/login/actions";
import { switchOrganizationAction } from "@/app/(admin)/platform/actions";
import { NAV_COOKIE } from "@/lib/nav";

/**
 * The app's navigation. Desktop: a sidebar grouped by area that can be collapsed to an icon rail
 * (remembered in this browser). Phones and tablets: a top bar with a menu button that slides the same
 * menu in, and hides it again after a choice (like Veristart Insights' menu).
 */

const ICONS = {
  fleet: Truck,
  worksites: MapPinned,
  schedules: CalendarClock,
  alerts: Bell,
  subscriptions: BellRing,
  reports: BarChart3,
  operators: HardHat,
  checklists: ClipboardCheck,
  training: GraduationCap,
  users: UserCog,
  settings: Settings,
  platform: Shield,
} satisfies Record<string, LucideIcon>;

export type NavItem = { href: string; label: string; icon: keyof typeof ICONS; badge?: number | null };
export type NavGroup = { label: string; items: NavItem[] };
export type NavAccount = {
  email: string;
  organizationId: number;
  organizationName: string;
  /** Platform admins: the organizations they can switch to. */
  organizations: { id: number; name: string }[] | null;
};



/** The item for the current page: the longest href that matches (so /alerts/subscriptions isn't also "Alerts"). */
function activeHref(pathname: string, groups: NavGroup[]) {
  const hrefs = groups.flatMap((g) => g.items.map((i) => i.href));
  return hrefs
    .filter((h) => (h === "/" ? pathname === "/" || pathname.startsWith("/machines") : pathname === h || pathname.startsWith(`${h}/`)))
    .sort((a, b) => b.length - a.length)[0];
}

function Logo() {
  return (
    <Link href="/" className="text-lg font-semibold tracking-tight text-white">
      VS <span className="text-sky-400">Lab</span>
    </Link>
  );
}

function Badge({ count, compact = false }: { count: number; compact?: boolean }) {
  return (
    <span
      className={`rounded-full bg-red-600 text-xs font-semibold text-white ${compact ? "absolute -right-1 -top-1 px-1" : "ml-auto px-1.5"}`}
    >
      {count}
    </span>
  );
}

function Links({ groups, collapsed, onNavigate }: { groups: NavGroup[]; collapsed: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const active = activeHref(pathname, groups);
  return (
    <nav className="flex-1 space-y-4 overflow-y-auto px-2 py-3" aria-label="Main">
      {groups.map((group) => (
        <div key={group.label}>
          {collapsed ? (
            <div className="mx-2 mb-2 border-t border-slate-700" />
          ) : (
            <div className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">{group.label}</div>
          )}
          {group.items.map((item) => {
            const Icon = ICONS[item.icon];
            const isActive = item.href === active;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                title={collapsed ? item.label : undefined}
                aria-current={isActive ? "page" : undefined}
                className={`relative flex items-center gap-3 rounded-md px-3 py-2 text-sm ${collapsed ? "justify-center" : ""} ${
                  isActive ? "bg-slate-800 font-medium text-white" : "text-slate-300 hover:bg-slate-800/60 hover:text-white"
                }`}
              >
                <span className="relative">
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  {collapsed && !!item.badge && <Badge count={item.badge} compact />}
                </span>
                {!collapsed && item.label}
                {!collapsed && !!item.badge && <Badge count={item.badge} />}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function Account({ account, collapsed }: { account: NavAccount; collapsed: boolean }) {
  return (
    <div className="space-y-2 border-t border-slate-800 px-3 py-3 text-sm text-slate-300">
      {!collapsed &&
        (account.organizations ? (
          <form action={switchOrganizationAction} className="flex items-center gap-1">
            <label htmlFor="org-switch" className="sr-only">
              Organization
            </label>
            <select
              id="org-switch"
              name="organizationId"
              defaultValue={account.organizationId}
              className="min-w-0 flex-1 rounded bg-slate-800 px-2 py-1 text-white"
            >
              {account.organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <button className="rounded border border-slate-600 px-2 py-1 hover:bg-slate-800">View</button>
          </form>
        ) : (
          <div className="flex items-center gap-2 font-medium text-white">
            <Building2 className="h-4 w-4" aria-hidden />
            {account.organizationName}
          </div>
        ))}
      {!collapsed && <div className="truncate text-xs text-slate-400">{account.email}</div>}
      <form action={signOutAction}>
        <button
          className={`flex w-full items-center gap-3 rounded-md px-0 py-1 hover:text-white ${collapsed ? "justify-center" : ""}`}
          title={collapsed ? "Sign out" : undefined}
        >
          <LogOut className="h-4 w-4" aria-hidden />
          {!collapsed && "Sign out"}
        </button>
      </form>
    </div>
  );
}

export function AppNav({
  groups,
  account,
  alertCount,
  initiallyCollapsed,
}: {
  groups: NavGroup[];
  account: NavAccount;
  alertCount: number | null;
  initiallyCollapsed: boolean;
}) {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  const [open, setOpen] = useState(false);
  // Remembered per browser in a cookie, so the page is drawn at the right width straight away.
  const toggleCollapsed = () => {
    document.cookie = `${NAV_COOKIE}=${collapsed ? "open" : "collapsed"}; path=/; max-age=31536000; samesite=lax`;
    setCollapsed(!collapsed);
  };

  // The phone menu closes after a choice (onNavigate), on Escape, and when tapping outside it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      {/* Phones and tablets: top bar + slide-in menu. */}
      <header className="sticky top-0 z-[1100] flex items-center gap-3 bg-slate-900 px-4 py-3 text-white lg:hidden">
        <button onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open} className="rounded p-1 hover:bg-slate-800">
          <Menu className="h-5 w-5" />
        </button>
        <Logo />
        <span className="ml-auto truncate text-sm text-slate-300">{account.organizationName}</span>
        <Link href="/alerts" aria-label="Alerts" className="relative rounded p-1 hover:bg-slate-800">
          <Bell className="h-5 w-5" />
          {!!alertCount && <Badge count={alertCount} compact />}
        </Link>
      </header>
      {open && (
        <div className="fixed inset-0 z-[1200] lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-slate-900 shadow-xl">
            <div className="flex items-center justify-between px-4 py-3">
              <Logo />
              <button onClick={() => setOpen(false)} aria-label="Close menu" className="rounded p-1 text-slate-300 hover:bg-slate-800">
                <X className="h-5 w-5" />
              </button>
            </div>
            <Links groups={groups} collapsed={false} onNavigate={() => setOpen(false)} />
            <Account account={account} collapsed={false} />
          </div>
        </div>
      )}

      {/* Desktop: sidebar, collapsible to icons. */}
      <aside
        className={`sticky top-0 hidden h-screen shrink-0 flex-col bg-slate-900 transition-[width] lg:flex ${collapsed ? "w-16" : "w-60"}`}
      >
        <div className={`flex items-center px-4 py-4 ${collapsed ? "justify-center px-0" : ""}`}>
          {collapsed ? (
            <Link href="/" className="text-lg font-semibold text-sky-400" title="VS Lab">
              VS
            </Link>
          ) : (
            <Logo />
          )}
        </div>
        <Links groups={groups} collapsed={collapsed} />
        <Account account={account} collapsed={collapsed} />
        <button
          onClick={toggleCollapsed}
          className="flex items-center justify-center gap-2 border-t border-slate-800 py-2 text-xs text-slate-400 hover:text-white"
          aria-label={collapsed ? "Expand menu" : "Collapse menu"}
          title={collapsed ? "Expand menu" : "Collapse menu"}
        >
          {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
          {!collapsed && "Collapse"}
        </button>
      </aside>
    </>
  );
}
