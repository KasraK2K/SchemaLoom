'use client';

import type { EngineProps } from '@schemaloom/schema-model';
import { cn } from '@schemaloom/ui';
import { useState } from 'react';
import type {
  EngineNodeProps,
  EngineUiPlugin,
  PropertyPanelProps,
  PropertyPanelSection,
  TypeBadgeProps,
  TypePickerProps,
} from './contract';

/**
 * §16.4 — what renders for an engine that ships no UI package.
 *
 * It is NOT an error screen. Terminology, capabilities, the type catalog and `propsSchemas`
 * all come from the client facet, not from the plugin, so a backend-only engine is usable on
 * day one: correct nouns, correct feature gating, a working type picker and an editable
 * engineProps bag. Its UI package is a polish step, not a blocker — which is what makes "add
 * an engine without touching core" true in practice rather than on paper.
 */

function FallbackTypeBadge({ resolved, compact }: TypeBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded bg-surface-sunken font-mono text-text-muted',
        compact ? 'px-1 text-[11px] leading-4' : 'px-1.5 py-0.5 text-xs',
      )}
    >
      {resolved.display}
    </span>
  );
}

/** A plain select over `listPickerOptions`. No parameter inputs: the option's `value` is
 *  already a canonical `TypeRef`, so picking one is always a legal write. */
function FallbackTypePicker({ value, options, disabled, onChange }: TypePickerProps) {
  return (
    <select
      className="h-8 rounded-md border border-border bg-surface px-2 text-sm text-text"
      disabled={disabled}
      value={value.name}
      onChange={(event) => {
        const picked = options.find((option) => option.value.name === event.target.value);
        if (picked !== undefined) onChange(picked.value);
      }}
    >
      {options.some((option) => option.value.name === value.name) ? null : (
        <option value={value.name}>{value.name}</option>
      )}
      {options.map((option) => (
        <option key={option.value.name} value={option.value.name}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function FallbackNode({
  entity,
  fields,
  badges,
  resolvedTypes,
  engine,
  selected,
  collapsed,
  highlightedFieldIds,
  FieldHandle,
  onFieldSelect,
  onToggleCollapse,
}: EngineNodeProps) {
  const kind = engine.capabilities.entityKinds.find((k) => k.id === entity.kind);
  return (
    <div
      className={cn(
        'min-w-48 overflow-hidden rounded-lg border bg-surface shadow-sm',
        selected ? 'border-(--sl-select) ring-1 ring-(--sl-select)' : 'border-border',
      )}
    >
      <button
        type="button"
        onClick={onToggleCollapse}
        className="flex w-full items-center gap-2 border-b border-border bg-surface-raised px-2 py-1.5 text-left"
      >
        {kind === undefined ? null : (
          <span className="rounded bg-surface-sunken px-1 text-[10px] font-semibold text-text-subtle">
            {kind.shortCode}
          </span>
        )}
        <span className="truncate text-sm font-medium text-text">{entity.name}</span>
      </button>
      {collapsed ? null : (
        <ul className="divide-y divide-border">
          {fields.map((field) => {
            const marks = badges.get(field.id);
            const resolved = resolvedTypes.get(field.id);
            return (
              <li
                key={field.id}
                className={cn(
                  'flex items-center gap-2 px-2 py-1 text-xs',
                  highlightedFieldIds.has(field.id) && 'bg-accent-subtle',
                )}
              >
                <FieldHandle fieldId={field.id} side="target" />
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => {
                    onFieldSelect(field.id);
                  }}
                >
                  <span className="truncate text-text">{field.name}</span>
                  {marks?.primaryKey === true ? <span className="text-accent-text">PK</span> : null}
                  {marks?.foreignKey === true ? <span className="text-accent-text">FK</span> : null}
                  {marks?.unique === true ? <span className="text-accent-text">UQ</span> : null}
                  <span className="ml-auto shrink-0">
                    {resolved === undefined ? null : (
                      <FallbackTypeBadge resolved={resolved} compact />
                    )}
                  </span>
                </button>
                <FieldHandle fieldId={field.id} side="source" />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The raw engineProps editor. An engine with no UI package still owns a props bag, and
 * without this it would be uneditable — the difference between "unpolished" and "read only".
 *
 * ponytail: a JSON textarea, not a form generated from `engine.propsSchemas`. Generating
 * controls needs zod introspection per schema node, and `PropertyPanelProps` does not carry
 * the `EnginePropsKind`/sub-kind pair the resolver needs to pick a schema anyway. Invalid
 * input costs one round trip and comes back as a diagnostic. Generate the form when a second
 * engine ships without a UI package.
 */
function RawPropsEditor<
  T extends { readonly engineProps: EngineProps; readonly propsRedacted?: true },
>({ object, readOnly, onChange }: PropertyPanelProps<T>) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? JSON.stringify(object.engineProps, null, 2);
  const parsed = ((): EngineProps | null => {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as EngineProps)
        : null;
    } catch {
      return null;
    }
  })();

  if (object.propsRedacted === true) {
    return (
      <p className="px-1 py-2 text-xs text-text-subtle">Some properties are hidden from you.</p>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <textarea
        rows={6}
        spellCheck={false}
        disabled={readOnly}
        className={cn(
          'w-full rounded-md border bg-surface p-2 font-mono text-xs text-text',
          parsed === null ? 'border-danger' : 'border-border',
        )}
        value={text}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={() => {
          if (parsed !== null) onChange({ engineProps: parsed });
          setDraft(null);
        }}
      />
      {parsed === null ? (
        <span className="text-xs text-danger-text">Not a JSON object.</span>
      ) : null}
    </div>
  );
}

function rawSection<T extends { readonly engineProps: EngineProps; readonly propsRedacted?: true }>(
  id: string,
): readonly PropertyPanelSection<T>[] {
  return [
    {
      id,
      title: 'Engine properties',
      order: 900,
      defaultCollapsed: true,
      Component: RawPropsEditor,
    },
  ];
}

export const FALLBACK_ENGINE_UI: EngineUiPlugin = {
  // Not a real engine id. Nothing compares it; it exists so a logged plugin is identifiable.
  engineId: 'fallback',
  nodeRenderers: {},
  defaultNodeRenderer: FallbackNode,
  panels: {
    entity: rawSection('core.raw-props.entity'),
    field: rawSection('core.raw-props.field'),
    link: rawSection('core.raw-props.link'),
    index: rawSection('core.raw-props.index'),
    constraint: rawSection('core.raw-props.constraint'),
    customType: rawSection('core.raw-props.customType'),
  },
  TypePicker: FallbackTypePicker,
  TypeBadge: FallbackTypeBadge,
  // No editor language: CodeMirror falls back to plain text (§16.4).
};
