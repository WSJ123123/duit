interface SkeletonProps {
  className?: string;
}

/** Token-colored shimmer block for route loading silhouettes. No text, ever. */
export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={`animate-pulse rounded-lg motion-reduce:animate-none ${className ?? ""}`}
      style={{ background: "var(--grid)" }}
      aria-hidden="true"
    />
  );
}
