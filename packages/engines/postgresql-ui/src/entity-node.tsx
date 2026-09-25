import { formatMessage } from '@schemaloom/engine-sdk/ui';
import { ChevronDown, ChevronRight, cn } from '@schemaloom/ui';
import type { EngineNodeProps } from './contract.js';
import { FieldRow } from './field-row.js';
import { resolveIcon } from './icons.js';

/**
 * One renderer for every PostgreSQL entity kind. A view and a table differ in the DATA core
 * already hands over — a view's `badges` map is empty because it has no constraints, and its
 * `FieldHandle` renders nothing because `canBeLinkEndpoint` is false — so branching on
 * `entity.kind` would be re-deriving what the props already say. The kind shows up in exactly
 * one place: the header icon and label, both looked up, never hard-coded.
 */
export function PostgresEntityNode({
  entity,
  fields,
  badges,
  resolvedTypes,
  engine,
  selected,
  collapsed,
  highlightedFieldIds,
  areaColor,
  diagnostics,
  FieldHandle,
  onFieldSelect,
  onToggleCollapse,
}: EngineNodeProps) {
  const kind = engine.capabilities.entityKinds.find((k) => k.id === entity.kind);
  const KindIcon = resolveIcon(kind?.icon ?? engine.icon);
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const worst = diagnostics.some((d) => d.severity === 'error')
    ? 'bg-danger'
    : diagnostics.some((d) => d.severity === 'warning')
      ? 'bg-warning'
      : null;

  return (
    <div
      className={cn(
        'min-w-48 overflow-hidden rounded-lg border bg-surface shadow-sm',
        selected ? 'border-accent ring-1 ring-accent' : 'border-border',
      )}
      style={areaColor === null ? undefined : { borderTopColor: areaColor, borderTopWidth: 3 }}
    >
      <header className="flex items-center gap-2 border-b border-border bg-surface-raised px-2 py-1.5">
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          className="text-text-subtle"
        >
          <Chevron className="size-3.5" />
        </button>
        <KindIcon className="size-4 text-text-subtle" />
        <span className="truncate text-sm font-medium text-text">{entity.name}</span>
        {entity.restricted === true ? (
          <span aria-label="Restricted" title="Restricted">
            &#128274;
          </span>
        ) : null}
        {worst === null ? null : (
          <span className={cn('ml-auto size-2 rounded-full', worst)} aria-label="Has diagnostics" />
        )}
      </header>

      {collapsed || kind?.hasFields === false ? null : fields.length === 0 ? (
        <p className="px-2 py-2 text-xs text-text-subtle">
          {formatMessage(engine.terminology, 'list.empty', 'field')}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {fields.map((field) => (
            <FieldRow
              key={field.id}
              field={field}
              badges={badges.get(field.id)}
              resolved={resolvedTypes.get(field.id)}
              highlighted={highlightedFieldIds.has(field.id)}
              FieldHandle={FieldHandle}
              onSelect={onFieldSelect}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
