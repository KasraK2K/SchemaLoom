import { cn } from '@schemaloom/ui';
import type { GrantWarning } from './grant-warnings';

/**
 * The footgun, said out loud. Rendered above the Save button, not after the write —
 * "you have made Billing read-only for Ana" is a bug report, not a warning.
 *
 * It never blocks the save. R15 is the intended rule and narrowing is sometimes exactly
 * what the manager meant; the failure this prevents is not knowing.
 */
export function GrantWarningNotice({ warnings }: { readonly warnings: readonly GrantWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1" role="status">
      {warnings.map((warning) => (
        <li
          key={warning.code}
          data-warning={warning.code}
          className={cn(
            'rounded-md border px-2 py-1.5 text-xs',
            warning.code === 'narrows'
              ? 'border-warning bg-warning-subtle text-warning-text'
              : 'border-border bg-surface-sunken text-text-muted',
          )}
        >
          {warning.message}
        </li>
      ))}
    </ul>
  );
}
