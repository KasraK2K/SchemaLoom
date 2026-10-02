import { cn } from '@schemaloom/ui';
import type { TypeBadgeProps } from '@schemaloom/engine-sdk/ui';

/**
 * The rendered spelling comes from `ResolvedType.display`, which the type catalog owns. This
 * component only decides how it looks — it never re-renders a type name from `ref.name` and
 * args, because that is the second renderer doc 04 deleted `TypeRef.display` to prevent.
 */
export function PostgresTypeBadge({ resolved, compact }: TypeBadgeProps) {
  const unknown = resolved.status === 'unknown';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded font-mono tabular-nums',
        compact ? 'px-1 text-[11px] leading-4' : 'px-1.5 py-0.5 text-xs',
        unknown
          ? 'bg-warning-subtle text-warning-text'
          : resolved.status === 'user-defined'
            ? 'bg-accent-subtle text-accent-text'
            : 'bg-surface-sunken text-text-muted',
      )}
      title={unknown ? `Unrecognised type: ${resolved.display}` : resolved.display}
    >
      {resolved.display}
    </span>
  );
}
