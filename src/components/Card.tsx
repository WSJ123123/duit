import type { ReactNode } from "react";

interface CardProps {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}

export function Card({ title, subtitle, children, className }: CardProps) {
  return (
    <div
      className={`rounded-2xl p-4 ${className ?? ""}`}
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
    >
      {title ? (
        <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--ink-1)" }}>
          {title}
        </h3>
      ) : null}
      {subtitle ? (
        <p className="mb-3 text-xs" style={{ color: "var(--ink-3)" }}>
          {subtitle}
        </p>
      ) : null}
      {children}
    </div>
  );
}
