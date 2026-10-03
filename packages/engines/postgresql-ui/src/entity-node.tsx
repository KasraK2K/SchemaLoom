import { formatMessage } from '@schemaloom/engine-sdk/ui';
import { ChevronDown, ChevronRight, cn } from '@schemaloom/ui';
import type { EngineNodeProps } from '@schemaloom/engine-sdk/ui';
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
        'min-w-52 overflow-hidden rounded-lg border bg-surface-raised shadow-node transition-shadow',
        selected ? 'border-accent ring-[3px] ring-accent/25' : 'border-border-strong',
      )}
    >
      {/* The area's colour tints the header band: the card says where it belongs without
          a stripe competing with the selection ring. */}
      <header
        className={cn(
          'flex items-center gap-2 border-b border-border px-2.5 py-2',
          areaColor === null && 'bg-surface-sunken',
        )}
        style={areaColor === null ? undefined : { backgroundColor: areaColor }}
      >
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          className="rounded text-text-subtle hover:text-text"
        >
          <Chevron className="size-3.5" />
        </button>
        <KindIcon className="size-3.5 text-text-muted" />
        <span className="truncate text-[13px] font-semibold text-text">{entity.name}</span>
        {kind?.hasFields === false ? null : (
          <span className="ml-auto pl-2 font-mono text-[10.5px] text-text-subtle">
            {fields.length}
          </span>
        )}
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
        <ul className="divide-y divide-border/60">
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
