"use client";

import { createContext, useContext, type ElementType, type ReactNode } from "react";

const TipsContext = createContext(true);

export function TipsProvider({
  showTips,
  children,
}: {
  showTips: boolean;
  children: ReactNode;
}) {
  return <TipsContext.Provider value={showTips}>{children}</TipsContext.Provider>;
}

export function useTips(): boolean {
  return useContext(TipsContext);
}

/**
 * Explanatory "sub" line — the v3/v4 mockups' muted small-text treatment used
 * for card subtitles, row sub-labels and help text (mockup class `.tip`,
 * hidden wholesale by the `tips-off` toggle). Renders nothing when the user
 * has "Show tips" switched off in Settings. Defaults to a block `<p>`; pass
 * `as="span"` for the inline row-label form.
 */
export function Tip({
  children,
  className,
  as: Tag = "p",
}: {
  children: ReactNode;
  className?: string;
  as?: ElementType;
}) {
  const showTips = useTips();
  if (!showTips) return null;
  return (
    <Tag className={`text-xs ${className ?? ""}`} style={{ color: "var(--ink-3)" }}>
      {children}
    </Tag>
  );
}
