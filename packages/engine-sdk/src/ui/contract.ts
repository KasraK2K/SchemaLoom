/**
 * The React-typed engine UI contract — doc 03 §16.1. Types only.
 *
 * It lives in `@schemaloom/engine-sdk/ui`, where §16 puts it, so that a second engine's UI
 * package (roadmap 9) does not have to depend on the PostgreSQL one to get its types.
 * engine-sdk takes `@types/react` as a DEV dependency and nothing from React at runtime:
 * every import below is `import type`, which the build erases, so `apps/api` (which also
 * resolves engine-sdk) gains no React.
 *
 * NOTHING RUNTIME MAY BE ADDED TO THIS FILE.
 */
import type { EngineCapabilities } from '../capabilities.js';
import type { EngineStaticFacet } from '../definition.js';
import type { Diagnostic, EngineId } from '../diagnostics.js';
import type { LinkCheck } from '../links.js';
import type { ResolvedType, TypePickerOption } from '../type-catalog.js';
import type {
  Constraint,
  CustomType,
  EngineProps,
  Entity,
  Field,
  Id,
  Index,
  Link,
  SchemaModel,
  TypeRef,
} from '@schemaloom/schema-model';
import type { ComponentType, ReactNode } from 'react';

/**
 * PK / FK / unique are NOT field flags — doc 04 §2.6 derives them from `Constraint` and
 * `Link` objects through the model index, so the truth lives in one place. Core computes the
 * derivation ONCE per entity and hands it over; without this the renderer would re-derive it
 * from the whole model on every canvas frame.
 */
export interface FieldBadges {
  readonly primaryKey: boolean;
  readonly foreignKey: boolean;
  readonly unique: boolean;
}

export interface EngineNodeProps {
  readonly entity: Entity;
  /** already ordered by `ordinal` (C11), already redacted */
  readonly fields: readonly Field[];
  readonly badges: ReadonlyMap<Id, FieldBadges>;
  /**
   * DEVIATION from §16.1, same argument as `badges`. A card draws a type per row, and
   * `typeCatalog.resolve` needs a `TypeResolutionContext` (the project's custom types and the
   * entity's namespace name) that `EngineNodeProps` does not otherwise carry. Core resolves
   * once per entity; the alternative is every renderer rebuilding the context per frame, or
   * not drawing types at all.
   */
  readonly resolvedTypes: ReadonlyMap<Id, ResolvedType>;
  /**
   * DEVIATION from §16.1. The renderer needs terminology ("No columns yet") and entity-kind
   * descriptors, and an engine UI package cannot reach core's `useEngine()` hook. Passing the
   * facet it was selected for is the one line that avoids a second registry.
   */
  readonly engine: EngineStaticFacet;
  readonly selected: boolean;
  readonly collapsed: boolean;
  /** AI glow + search highlight, driven by core */
  readonly highlightedFieldIds: ReadonlySet<Id>;
  readonly areaColor: string | null;
  readonly diagnostics: readonly Diagnostic[];
  /**
   * Supplied by core, wrapping React Flow's `<Handle>` with the id convention the edge layer
   * expects (`<fieldId>:source` / `<fieldId>:target`). The renderer places one pair per field
   * row and never constructs a handle itself. When `features.links` is false core supplies a
   * component that renders `null`, so hiding connection handles needs no branch here.
   */
  readonly FieldHandle: ComponentType<{ readonly fieldId: Id; readonly side: 'source' | 'target' }>;
  readonly onFieldSelect: (fieldId: Id) => void;
  readonly onToggleCollapse: () => void;
}

export interface PropertyPanelProps<T> {
  readonly object: T;
  readonly model: SchemaModel;
  readonly engine: EngineStaticFacet;
  readonly readOnly: boolean;
  /** already filtered to this object, already rendered to strings by core */
  readonly diagnostics: readonly Diagnostic[];
  /** the ONLY mutation path: core owns optimistic update, version bump (C7) and rollback */
  readonly onChange: (patch: { readonly engineProps: EngineProps }) => void;
}

export interface PropertyPanelSection<T> {
  /** 'pg.column.identity' */
  readonly id: string;
  readonly title: string;
  /** ascending; core sections occupy 0, 100, 200… */
  readonly order: number;
  readonly defaultCollapsed: boolean;
  /** hidden automatically when the predicate is false; a predicate rather than a feature atom,
   *  for the reason in §16.5 — one atom per section cannot express "any of these" */
  readonly available?: (caps: EngineCapabilities) => boolean;
  readonly Component: ComponentType<PropertyPanelProps<T>>;
}

export interface TypePickerProps {
  /** a `TypeRef`, not a string: a bare string would force the caller to re-parse it and could
   *  not express `numeric(10,2)[]` or a custom-type reference at all */
  readonly value: TypeRef;
  /** from `typeCatalog.listPickerOptions` */
  readonly options: readonly TypePickerOption[];
  readonly resolved: ResolvedType;
  readonly disabled: boolean;
  readonly onChange: (next: TypeRef) => void;
}

export interface TypeBadgeProps {
  readonly resolved: ResolvedType;
  /** true on canvas nodes, false in the inspector */
  readonly compact: boolean;
}

/** How core draws an edge for one link kind. The RULES are declarative data on
 *  `capabilities.linkKinds` and evaluated by the shared `checkLink`; this is appearance only,
 *  which is the half core genuinely cannot derive. */
export interface LinkStyle {
  readonly sourceMarker: 'none' | 'one' | 'many' | 'arrow';
  readonly targetMarker: 'none' | 'one' | 'many' | 'arrow';
  /** a documentation-only link is drawn dashed */
  readonly dashed: boolean;
}

/** An icon the engine names on its facet (`EngineStaticFacet.icon`,
 *  `EntityKindDescriptor.icon`) resolved to a component. Core falls back to a generic icon. */
export type EngineIcon = ComponentType<{ readonly className?: string }>;

export interface EngineUiPlugin {
  readonly engineId: EngineId;
  /** keyed by `EntityKindDescriptor.id` */
  readonly nodeRenderers: Readonly<Record<string, ComponentType<EngineNodeProps>>>;
  readonly defaultNodeRenderer?: ComponentType<EngineNodeProps>;
  readonly panels: {
    readonly entity?: readonly PropertyPanelSection<Entity>[];
    readonly field?: readonly PropertyPanelSection<Field>[];
    readonly link?: readonly PropertyPanelSection<Link>[];
    readonly index?: readonly PropertyPanelSection<Index>[];
    readonly constraint?: readonly PropertyPanelSection<Constraint>[];
    readonly customType?: readonly PropertyPanelSection<CustomType>[];
  };
  readonly TypePicker?: ComponentType<TypePickerProps>;
  readonly TypeBadge?: ComponentType<TypeBadgeProps>;
  /** keyed by the icon names the facet uses */
  readonly icons?: Readonly<Record<string, EngineIcon>>;
  /** keyed by `LinkKindDescriptor.id` */
  readonly linkStyles?: Readonly<Record<string, LinkStyle>>;
  /**
   * Lazily imports the engine's CodeMirror language package. `unknown` rather than
   * `@codemirror/state`'s `Extension` because an engine UI package must not be forced to
   * depend on CodeMirror to satisfy this type; core narrows it at the one call site that
   * feeds the editor. Omit it and core loads a language from
   * `capabilities.queryLanguage.codeMirrorMode` instead.
   */
  readonly loadEditorLanguage?: () => Promise<unknown>;
  /** optional flavour text on a rejected drag, e.g. "add a junction table for N:M" */
  readonly connectionHint?: (check: LinkCheck) => ReactNode | null;
}
