import type { CustomType, Id, TypeRef } from './ir.js';

export type TypeCategory =
  | 'numeric'
  | 'string'
  | 'boolean'
  | 'temporal'
  | 'binary'
  | 'json'
  | 'uuid'
  | 'geometric'
  | 'network'
  | 'range'
  | 'user-defined'
  | 'other';

/**
 * Parameters are not all numbers. `geometry(Point, 4326)` and `interval day to second(3)` take
 * a non-numeric argument, and `TypeRef.args` is `(string | number)[]` for exactly that reason:
 * a numbers-only descriptor would drop the first argument on resolution and
 * `format(resolve(ref, ctx))` would stop round-tripping the stored ref.
 */
export type TypeParameterDescriptor =
  | {
      readonly kind: 'number';
      readonly name: 'length' | 'precision' | 'scale' | (string & Record<never, never>);
      readonly label: string;
      readonly required: boolean;
      readonly min: number;
      readonly max: number;
      /** pre-filled in the picker; null = leave blank */
      readonly default: number | null;
    }
  | {
      readonly kind: 'string';
      readonly name: string;
      readonly label: string;
      readonly required: boolean;
      readonly default: string | null;
    }
  | {
      readonly kind: 'enum';
      readonly name: string;
      readonly label: string;
      readonly required: boolean;
      readonly options: readonly string[];
      readonly default: string | null;
    };

export interface TypeDescriptor {
  /** canonical lowercase id, and the exact spelling the exporter emits: 'varchar', 'numeric' */
  readonly id: string;
  readonly displayName: string;
  readonly category: TypeCategory;
  /** alternate spellings accepted on input: ['character varying'] */
  readonly aliases: readonly string[];
  /** empty = the type takes no parameters */
  readonly parameters: readonly TypeParameterDescriptor[];
  readonly supportsArray: boolean;
  /** pre-selected when the user picks this category in the type picker */
  readonly preferredForCategory: boolean;
  readonly deprecated: boolean;
  readonly summary: string;
}

export interface TypeResolutionContext {
  /** project-scoped user-defined types (enum / domain / composite) */
  readonly customTypes: readonly CustomType[];
  /** namespace of the field being resolved, for unqualified user-type lookup */
  readonly namespaceName: string | null;
}

export type TypeResolutionStatus = 'builtin' | 'user-defined' | 'unknown';

export interface ResolvedType {
  /** exactly the `TypeRef` stored on the field */
  readonly ref: TypeRef;
  /** normalised spelling — what the exporter writes and what the badge shows. Rendered on
   *  demand; it is NOT stored on the `TypeRef` (doc 04 deleted `display`). */
  readonly display: string;
  readonly status: TypeResolutionStatus;
  /** set when `status === 'builtin'` */
  readonly descriptor: TypeDescriptor | null;
  /** the resolved `CustomType` when `status === 'user-defined'`; null otherwise */
  readonly customType: CustomType | null;
  /** positional `TypeRef.args` mapped onto the descriptor's parameters:
   *  `numeric(10,2)` -> `{ precision: 10, scale: 2 }`. Empty for parameterless types. */
  readonly args: Readonly<Record<string, string | number>>;
  /** `ref.dimensions ?? 0` */
  readonly dimensions: number;
  readonly category: TypeCategory;
}

/** Total — never throws. An unrecognised name comes back as status 'unknown' with `display`
 *  echoing `ref.name` plus its arguments, so an imported exotic type survives a round trip. */
export type ResolveType = (ref: TypeRef, ctx: TypeResolutionContext) => ResolvedType;

export interface BuildTypeRefInput {
  readonly name: string;
  readonly args?: readonly (string | number)[];
  readonly dimensions?: number;
}

export interface TypePickerOption {
  /** the ref the picker writes to `Field.type` once parameters are filled in; already canonical */
  readonly value: TypeRef;
  readonly label: string;
  /** the picker's optgroup */
  readonly group: string;
  readonly parameters: readonly TypeParameterDescriptor[];
  readonly supportsArray: boolean;
  readonly summary: string;
  /** non-null for user-defined types; lets the picker deep-link to the type's own editor */
  readonly customTypeId: Id | null;
  readonly deprecated: boolean;
}

export interface TypeCatalog {
  readonly descriptors: readonly TypeDescriptor[];
  readonly resolve: ResolveType;
  /** The ONLY writer of a canonical `TypeRef`. The importer, the type picker and any quick fix
   *  build refs through this, so a stored ref is always canonical and `resolve` never guesses. */
  buildRef(input: BuildTypeRefInput, ctx: TypeResolutionContext): TypeRef;
  /** the rendered spelling; `format(resolve(buildRef(x, ctx), ctx))` is stable under repetition */
  format(resolved: ResolvedType): string;
  /** link endpoint compatibility, e.g. int4 <-> int4, int4 <-> serial, uuid <-> uuid */
  areCompatible(a: ResolvedType, b: ResolvedType): boolean;
  /** the flat, grouped option list the type picker renders (§5.4) */
  listPickerOptions(ctx: TypeResolutionContext): readonly TypePickerOption[];
}

export interface TypeCatalogOptions {
  readonly descriptors: readonly TypeDescriptor[];
  /** array syntax the engine uses. Two cases, because those are the two that exist across every
   *  engine in COMING_SOON; a third is added when an engine needs it. */
  readonly arraySyntax: 'suffix-brackets' | 'none';
  /** groups of canonical ids treated as link-compatible beyond exact equality */
  readonly compatibilityGroups: readonly (readonly string[])[];
  /** e.g. serial -> int4 before anything else looks at it */
  readonly normalizeAliases?: Readonly<Record<string, string>>;
  /**
   * How user-defined types enter the picker (§5.4), keyed by `CustomType.kind`; the value is
   * the optgroup heading, which is the engine's terminology plural ('Enums', 'Domains').
   * A kind with no entry is not offered as a field type — which is
   * `CustomTypeKindDescriptor.usableAsFieldType: false`, expressed where the picker reads it.
   * Omit the map entirely to offer every user type under its own kind id.
   */
  readonly userTypeGroups?: Readonly<Record<string, string>>;
}

/** Category -> optgroup heading for builtins. Engine-neutral, so it lives here rather than in
 *  each engine's terminology bundle, which owns object nouns and not type taxonomy. */
export const CATEGORY_GROUPS: Readonly<Record<TypeCategory, string>> = {
  numeric: 'Numeric',
  string: 'Text',
  boolean: 'Boolean',
  temporal: 'Date and time',
  binary: 'Binary',
  json: 'JSON',
  uuid: 'UUID',
  geometric: 'Geometric',
  network: 'Network',
  range: 'Range',
  'user-defined': 'User-defined',
  other: 'Other',
};
