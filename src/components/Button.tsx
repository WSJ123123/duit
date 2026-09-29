import type { ButtonHTMLAttributes, CSSProperties } from "react";

type Variant = "primary" | "secondary" | "ghost";

const VARIANT_STYLE: Record<Variant, CSSProperties> = {
  primary: { background: "var(--accent)", borderColor: "transparent", color: "#ffffff" },
  secondary: { background: "var(--surface)", borderColor: "var(--border)", color: "var(--ink-1)" },
  ghost: { background: "transparent", borderColor: "transparent", color: "var(--critical)" },
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export function Button({ variant = "secondary", className, style, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      className={`rounded-lg border px-3.5 py-2 text-sm font-medium disabled:opacity-60 ${className ?? ""}`}
      style={{ ...VARIANT_STYLE[variant], ...style }}
    />
  );
}
