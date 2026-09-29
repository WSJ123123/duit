"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Renders children into document.body via a portal, once mounted on the
 * client. Returns null during SSR and the first client render (before the
 * effect runs) — the caller's markup never depends on portal content being
 * present synchronously. Reused by every overlay (sheets, dialogs).
 */
export function Portal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Mount-detection: portals must not render during SSR/first paint since
    // document.body isn't available yet. One-time flip, not a render cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  if (!mounted) return null;
  return createPortal(children, document.body);
}
