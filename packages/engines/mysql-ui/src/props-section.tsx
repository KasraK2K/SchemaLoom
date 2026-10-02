import type { Diagnostic, EngineCapabilities } from '@schemaloom/engine-sdk/ui';
import type { EngineProps } from '@schemaloom/schema-model';
import { cn } from '@schemaloom/ui';
import type { PropertyPanelProps, PropertyPanelSection } from '@schemaloom/engine-sdk/ui';

/** Everything a panel section edits: the engine-owned bag plus R-1's blanking flag. */
export interface PropsBearing {
  readonly engineProps: EngineProps;
  readonly propsRedacted?: true;
}

export type PropControl =
  | {
      readonly kind: 'text';
      readonly name: string;
      readonly label: string;
      readonly placeholder?: string;
      readonly multiline?: boolean;
    }
  | {
      readonly kind: 'number';
      readonly name: string;
      readonly label: string;
      readonly min: number;
      readonly max: number;
    }
  | { readonly kind: 'boolean'; readonly name: string; readonly label: string }
  | {
      readonly kind: 'enum';
      readonly name: string;
      readonly label: string;
      readonly options: readonly string[];
    };

export interface PropsSectionSpec<T> {
  readonly id: string;
  readonly title: string;
  readonly order: number;
  readonly defaultCollapsed?: boolean;
  readonly available?: (caps: EngineCapabilities) => boolean;
  /** Per-OBJECT visibility, which `available` cannot express: `viewDefinition` belongs to a
   *  view, not to every entity. Capabilities gate the section; this gates the instance. */
  readonly visibleFor?: (object: T) => boolean;
  readonly controls: readonly PropControl[];
}

/** An empty string is not a value — every one of MySQL's optional props is `.optional()`
 *  over a non-empty schema, so clearing an input must DELETE the key, not write `''`. */
function withProp(props: EngineProps, name: string, value: unknown): EngineProps {
  if (value === undefined || value === '') {
    return Object.fromEntries(Object.entries(props).filter(([key]) => key !== name));
  }
  return { ...props, [name]: value };
}

function diagnosticFor(diagnostics: readonly Diagnostic[], name: string): Diagnostic | undefined {
  return diagnostics.find((d) => d.target.propPath?.[0] === name);
}

const inputClass =
  'h-8 w-full rounded-md border bg-surface px-2 text-sm text-text disabled:opacity-50';

/**
 * One renderer, four control kinds, and a descriptor array per object type. Hand-writing a
 * component per MySQL property would be ~30 near-identical forms; the shape of an
 * engineProps editor is genuinely uniform, so the variation lives in data.
 *
 * ponytail: no local zod validation — `onChange` is the only mutation path and core owns the
 * optimistic update, the version bump (C7) and the rollback, so an invalid value round-trips
 * and comes back as a diagnostic. Wire `engine.propsSchemas` in here when the round trip is
 * measurably annoying.
 */
export function propsSection<T extends PropsBearing>(
  spec: PropsSectionSpec<T>,
): PropertyPanelSection<T> {
  function Section({ object, readOnly, diagnostics, onChange }: PropertyPanelProps<T>) {
    if (spec.visibleFor?.(object) === false) return null;
    if (object.propsRedacted === true) {
      return (
        <p className="px-1 py-2 text-xs text-text-subtle">Some properties are hidden from you.</p>
      );
    }

    const set = (name: string, value: unknown): void => {
      onChange({ engineProps: withProp(object.engineProps, name, value) });
    };

    return (
      <div className="flex flex-col gap-2">
        {spec.controls.map((control) => {
          const raw = object.engineProps[control.name];
          const bad = diagnosticFor(diagnostics, control.name);
          const border = bad === undefined ? 'border-border' : 'border-danger';
          return (
            <label key={control.name} className="flex flex-col gap-1 text-xs text-text-muted">
              <span className="flex items-center gap-2">
                {control.label}
                {bad === undefined ? null : (
                  <span className="text-danger-text" title={bad.code}>
                    &#9888;
                  </span>
                )}
              </span>
              {control.kind === 'boolean' ? (
                <input
                  type="checkbox"
                  className="size-4 self-start"
                  disabled={readOnly}
                  checked={raw === true}
                  onChange={(event) => {
                    set(control.name, event.target.checked ? true : undefined);
                  }}
                />
              ) : control.kind === 'enum' ? (
                <select
                  className={cn(inputClass, border)}
                  disabled={readOnly}
                  value={typeof raw === 'string' ? raw : ''}
                  onChange={(event) => {
                    set(control.name, event.target.value);
                  }}
                >
                  <option value="" />
                  {control.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : control.kind === 'number' ? (
                <input
                  type="number"
                  className={cn(inputClass, border)}
                  min={control.min}
                  max={control.max}
                  disabled={readOnly}
                  value={typeof raw === 'number' ? String(raw) : ''}
                  onChange={(event) => {
                    const text = event.target.value;
                    set(control.name, text === '' ? undefined : Number(text));
                  }}
                />
              ) : control.multiline === true ? (
                <textarea
                  rows={4}
                  className={cn(inputClass, border, 'h-auto py-1 font-mono')}
                  placeholder={control.placeholder}
                  disabled={readOnly}
                  value={typeof raw === 'string' ? raw : ''}
                  onChange={(event) => {
                    set(control.name, event.target.value);
                  }}
                />
              ) : (
                <input
                  type="text"
                  className={cn(inputClass, border)}
                  placeholder={control.placeholder}
                  disabled={readOnly}
                  value={typeof raw === 'string' ? raw : ''}
                  onChange={(event) => {
                    set(control.name, event.target.value);
                  }}
                />
              )}
            </label>
          );
        })}
      </div>
    );
  }

  return {
    id: spec.id,
    title: spec.title,
    order: spec.order,
    defaultCollapsed: spec.defaultCollapsed ?? false,
    available: spec.available,
    Component: Section,
  };
}
