"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

function IconAdd() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 8v8M8 12h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function IconActivity() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function IconBudget() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M4 19V10M10 19V5M16 19v-7M21 19H3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function IconMore() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <circle cx="6" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="18" cy="12" r="1.6" fill="currentColor" />
    </svg>
  );
}

interface TabItem {
  label: string;
  href: string | null;
  icon: () => ReactNode;
}

const TAB_ITEMS: TabItem[] = [
  { label: "Add", href: "/quick", icon: IconAdd },
  { label: "Activity", href: "/transactions", icon: IconActivity },
  { label: "Budget", href: "/budget", icon: IconBudget },
  { label: "More", href: "/more", icon: IconMore },
];

export function TabBar() {
  const pathname = usePathname();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 flex md:hidden"
      style={{
        borderTop: "1px solid var(--border)",
        background: "var(--surface)",
        paddingBottom: "env(safe-area-inset-bottom, 10px)",
      }}
    >
      {TAB_ITEMS.map((item) => {
        const active = item.href !== null && pathname.startsWith(item.href);
        const inner = (
          <span
            className="flex flex-col items-center gap-1 py-2.5 text-[11px]"
            style={{
              color: item.href === null ? "var(--ink-3)" : active ? "var(--accent)" : "var(--ink-3)",
              fontWeight: active ? 600 : 400,
            }}
          >
            <span style={{ width: 22, height: 22 }}>
              <item.icon />
            </span>
            {item.label}
          </span>
        );

        if (item.href === null) {
          return (
            <div key={item.label} aria-disabled="true" className="flex-1 cursor-default text-center">
              {inner}
            </div>
          );
        }
        return (
          <Link key={item.label} href={item.href} className="flex-1 text-center">
            {inner}
          </Link>
        );
      })}
    </nav>
  );
}
