import type { ReactNode } from 'react';
import { cn } from './cn.js';

/** One placeholder shape, the size and radius of what will replace it. */
export function Skeleton({ className }: { readonly className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-surface-sunken', className)}
    />
  );
}

/**
 * A loading state shaped like the content it stands in for. The placeholders are hidden
 * from assistive technology; `label` is what a screen reader hears instead.
 */
export function Loading({
  label = 'Loading…',
  className,
  children,
}: {
  readonly label?: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div role="status" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** Rows of text-line placeholders, a common shape for lists and panels. */
export function SkeletonRows({ rows = 3 }: { readonly rows?: number }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <Skeleton className="h-3 w-2/5" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      ))}
    </div>
  );
}
