import type { ResolvedType } from '@schemaloom/engine-sdk/ui';
import type { Field } from '@schemaloom/schema-model';
import { cn } from '@schemaloom/ui';
import type { ComponentType, ReactNode } from 'react';
import type { FieldBadges } from '@schemaloom/engine-sdk/ui';
import { MySqlTypeBadge } from './type-badge.js';

/** PK / FK / UNIQUE, in the order a reader scans them. The letters are not terminology: they
 *  are the constraint kinds' universal shorthand and they do not change per engine. */
function BadgeMarks({ badges }: { readonly badges: FieldBadges | undefined }): ReactNode {
  if (badges === undefined) return null;
  const marks: string[] = [];
  if (badges.primaryKey) marks.push('PK');
  if (badges.foreignKey) marks.push('FK');
  if (badges.unique) marks.push('UQ');
  if (marks.length === 0) return null;
  return (
    <span className="flex gap-1">
      {marks.map((mark) => (
        <span
          key={mark}
          className={cn(
            'rounded px-1 font-mono text-[9.5px] leading-4 font-semibold',
            // One accent: the key that identifies the row is jade, the rest stay neutral.
            mark === 'PK'
              ? 'bg-accent-subtle text-accent-text theme-blueprint:border-accent'
              : 'bg-surface-sunken text-text-muted theme-blueprint:border-border-strong',
            // Blueprint: outlined, like a stamp on a drawing.
            'theme-blueprint:rounded-none theme-blueprint:border theme-blueprint:bg-transparent',
          )}
        >
          {mark}
        </span>
      ))}
    </span>
  );
}

export interface FieldRowProps {
  readonly field: Field;
  readonly badges: FieldBadges | undefined;
  readonly resolved: ResolvedType | undefined;
  readonly highlighted: boolean;
  readonly FieldHandle: ComponentType<{
    readonly fieldId: string;
    readonly side: 'source' | 'target';
  }>;
  readonly onSelect: (fieldId: string) => void;
}

/**
 * Masking comes from the IR itself (RECONCILIATION R-1): a restricted field keeps its name,
 * ordinal, type and nullability and renders with a lock and no doc indicator. There is no
 * separate id set the renderer could forget to apply.
 */
export function FieldRow({
  field,
  badges,
  resolved,
  highlighted,
  FieldHandle,
  onSelect,
}: FieldRowProps) {
  return (
    <li
      className={cn(
        'relative flex items-center gap-2 px-2.5 py-(--sl-row-py) theme-compact:px-2 theme-compact:font-mono',
        highlighted && 'bg-accent-subtle',
      )}
    >
      <FieldHandle fieldId={field.id} side="target" />
      <button
        type="button"
        onClick={() => {
          onSelect(field.id);
        }}
        className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs"
      >
        <span
          className={cn(
            'truncate',
            field.isDeprecated && 'line-through',
            field.isNullable ? 'text-text-muted' : 'text-text',
          )}
        >
          {field.name}
        </span>
        {field.restricted === true ? (
          <span aria-label="Restricted" title="Restricted" className="text-text-subtle">
            &#128274;
          </span>
        ) : null}
        <BadgeMarks badges={badges} />
        <span className="ml-auto shrink-0">
          {resolved === undefined ? null : <MySqlTypeBadge resolved={resolved} compact />}
        </span>
      </button>
      <FieldHandle fieldId={field.id} side="source" />
    </li>
  );
}
