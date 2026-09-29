"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { AmountsToggle } from "@/components/Money";

const COLLAPSE_STORAGE_KEY = "duit:sidebar-collapsed";

function IconDashboard() {
  return (
    <svg viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="9" width="5.5" height="5.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function IconTransactions() {
  return (
    <svg viewBox="0 0 16 16" fill="none">
      <path d="M2 4h12M2 8h12M2 12h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconBudget() {
  return (
    <svg viewBox="0 0 16 16" fill="none">
      <path d="M2.5 13V7M6.5 13V3M10.5 13V9M14 13H2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconNetWorth() {
  return (
    <svg viewBox="0 0 16 16" fill="none">
      <path d="M2 11l4-4 3 3 5-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconInvestments() {
  return (
    <svg viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 5v3l2 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconGoals() {
  return (
    <svg viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function IconBills() {
  return (
    <svg viewBox="0 0 16 16" fill="none">
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.5 6.5h11M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconLogout() {
  return (
    <svg viewBox="0 0 16 16" fill="none">
      <path
        d="M6 2.5H3.5A1.5 1.5 0 0 0 2 4v8a1.5 1.5 0 0 0 1.5 1.5H6M10 11l3-3-3-3M13 8H6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Ruling 7 (mockup v7 §11): the footer's Logout row, between the email line
 * and Collapse. The SAME form the More page posts — `/logout` is an existing
 * route handler, so there is no new route and no client-side sign-out call.
 *
 * Its own component, not inline markup, because the Sidebar around it calls
 * `usePathname` and so cannot render outside an App Router context: this
 * shape is what lets the ruling's test assert the form's action and method.
 */
export function SidebarLogout({ collapsed }: { collapsed: boolean }) {
  return (
    <form action="/logout" method="post">
      <button
        type="submit"
        title="Logout"
        className={`mt-1 flex w-full items-center gap-2.5 overflow-hidden whitespace-nowrap rounded-[9px] text-[12.5px] font-semibold ${
          collapsed ? "justify-center px-0 py-[9px]" : "px-2.5 py-2"
        }`}
        style={{ color: "var(--critical)" }}
      >
        <span className="flex-shrink-0" style={{ width: 16, height: 16 }}>
          <IconLogout />
        </span>
        {!collapsed && <span>Logout</span>}
      </button>
    </form>
  );
}

/**
 * The footer above Collapse: the email line, Plan 9 ruling 5's `Hide amounts`
 * / `Show amounts` row (mockup v8 §14 — between the email line and Logout;
 * collapsed, icon-only with `title`, the Logout treatment), then Logout.
 * Its own component so the order can be tested in both states.
 */
export function SidebarFooter({ userEmail, collapsed }: { userEmail: string; collapsed: boolean }) {
  return (
    <>
      <div
        className="mt-auto overflow-hidden whitespace-nowrap px-2 pt-2 text-xs"
        style={{ color: "var(--ink-3)" }}
      >
        {!collapsed && userEmail}
      </div>
      <AmountsToggle variant="sidebar" collapsed={collapsed} />
      <SidebarLogout collapsed={collapsed} />
    </>
  );
}

function IconCollapse() {
  return (
    <svg viewBox="0 0 16 16" fill="none">
      <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface NavItem {
  label: string;
  href: string | null;
  icon: () => ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: IconDashboard },
  { label: "Transactions", href: "/transactions", icon: IconTransactions },
  { label: "Budget", href: "/budget", icon: IconBudget },
  { label: "Net Worth", href: "/net-worth", icon: IconNetWorth },
  { label: "Investments", href: "/investments", icon: IconInvestments },
  { label: "Goals", href: "/goals", icon: IconGoals },
  // Ruling 13: no count badge. A badge in a shared layout is a revalidation
  // trap of exactly the kind Session 9 caught, and the dashboard's `Due soon`
  // card is already the reminder surface.
  { label: "Bills", href: "/bills", icon: IconBills },
  { label: "Settings", href: "/settings", icon: IconSettings },
];

export function Sidebar({ userEmail }: { userEmail: string }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    // One-time read of a persisted UI preference from localStorage on mount,
    // deferred to an effect to avoid an SSR/client markup mismatch (server
    // has no localStorage). Not a render-cascade concern: this fires once.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsed(window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1");
  }, []);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  }

  return (
    <aside
      className="flex flex-shrink-0 flex-col gap-0.5 p-3 transition-[width] duration-150"
      style={{
        width: collapsed ? "64px" : "212px",
        background: "var(--surface)",
        borderRight: "1px solid var(--border)",
      }}
    >
      <div
        className="overflow-hidden whitespace-nowrap px-2 pb-4 text-lg font-bold tracking-tight"
        style={{ color: "var(--ink-1)" }}
      >
        {collapsed ? (
          <span>D</span>
        ) : (
          <span>
            Duit<span style={{ color: "var(--accent)" }}>.</span>
          </span>
        )}
      </div>

      {NAV_ITEMS.map((item) => {
        const active = item.href !== null && pathname.startsWith(item.href);
        const inner = (
          <span
            className="flex items-center gap-2.5 overflow-hidden whitespace-nowrap rounded-lg px-2.5 py-2 text-[13.5px]"
            style={{
              background: active ? "var(--accent-soft)" : "transparent",
              color: item.href === null ? "var(--ink-3)" : active ? "var(--ink-1)" : "var(--ink-2)",
              fontWeight: active ? 600 : 400,
            }}
          >
            <span className="flex-shrink-0 opacity-80" style={{ width: 16, height: 16 }}>
              <item.icon />
            </span>
            {!collapsed && <span>{item.label}</span>}
          </span>
        );

        if (item.href === null) {
          return (
            <div key={item.label} aria-disabled="true" className="cursor-default">
              {inner}
            </div>
          );
        }
        return (
          <Link key={item.label} href={item.href}>
            {inner}
          </Link>
        );
      })}

      <SidebarFooter userEmail={userEmail} collapsed={collapsed} />
      <button
        type="button"
        onClick={toggleCollapsed}
        className="mt-1.5 flex items-center gap-2.5 overflow-hidden whitespace-nowrap rounded-lg px-2.5 py-2 text-xs"
        style={{ color: "var(--ink-3)", border: "1px dashed var(--border)" }}
      >
        <span
          className="flex-shrink-0"
          style={{ width: 16, height: 16, transform: collapsed ? "rotate(180deg)" : undefined }}
        >
          <IconCollapse />
        </span>
        {!collapsed && <span>Collapse</span>}
      </button>
    </aside>
  );
}
