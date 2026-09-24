import type { CustomType, TypeRef } from './ir.js';
import {
  CATEGORY_GROUPS,
  type BuildTypeRefInput,
  type ResolvedType,
  type TypeCatalog,
  type TypeCatalogOptions,
  type TypeDescriptor,
  type TypePickerOption,
  type TypeResolutionContext,
} from './type-catalog.js';

/**
 * §5.2 — ONE implementation, not one per engine. Every v1 engine uses this; an engine writes
 * its own `TypeCatalog` only if its type grammar genuinely differs.
 *
 * Because `TypeRef` is already structured, the common path does no string parsing at all:
 * `resolve` matches `ref.name` against descriptor ids and aliases (case-insensitively, after
 * `normalizeAliases`), maps `ref.args` positionally onto `descriptor.parameters`, and falls
 * back to `ctx.customTypes` and then to 'unknown'. Parsing happens only in `buildRef`, which is
 * the one entry point that accepts a human-written spelling.
 */
export function createTypeCatalog(options: TypeCatalogOptions): TypeCatalog {
  const { descriptors, arraySyntax, compatibilityGroups, normalizeAliases, userTypeGroups } =
    options;

  /** lowercased id or alias -> descriptor */
  const byName = new Map<string, TypeDescriptor>();
  for (const d of descriptors) {
    byName.set(d.id.toLowerCase(), d);
    for (const alias of d.aliases) byName.set(alias.toLowerCase(), d);
  }
  const groups = compatibilityGroups.map((g) => new Set(g.map((id) => id.toLowerCase())));

  /** Strip a namespace qualifier, apply `normalizeAliases`, lowercase. */
  function canonical(name: string): string {
    const bare = name.includes('.') ? (name.split('.').pop() ?? name) : name;
    const lower = bare.trim().toLowerCase();
    return normalizeAliases?.[lower] ?? lower;
  }

  function renderArgs(args: readonly (string | number)[] | undefined): string {
    return args === undefined || args.length === 0 ? '' : `(${args.join(',')})`;
  }

  function renderDimensions(dimensions: number): string {
    return arraySyntax === 'suffix-brackets' ? '[]'.repeat(dimensions) : '';
  }

  function mapArgs(
    descriptor: TypeDescriptor | null,
    args: readonly (string | number)[] | undefined,
  ): Readonly<Record<string, string | number>> {
    if (descriptor === null || args === undefined) return {};
    const out: Record<string, string | number> = {};
    for (const [i, param] of descriptor.parameters.entries()) {
      const value = args[i];
      if (value !== undefined) out[param.name] = value;
    }
    return out;
  }

  /**
   * A ref naming a `customTypeId` that is not in the context is a DANGLING reference, not a
   * user type — so it resolves by id or not at all. Reporting it as 'unknown' with
   * `customType: null` is what lets the validator raise the dangling-reference diagnostic
   * §5.3 asks for, instead of silently rebinding to a same-named type.
   */
  function findCustomType(ctx: TypeResolutionContext, ref: TypeRef): CustomType | null {
    const id = ref.customTypeId;
    if (id !== undefined && id !== null) {
      return ctx.customTypes.find((c) => c.id === id) ?? null;
    }
    const wanted = canonical(ref.name);
    return ctx.customTypes.find((c) => canonical(c.name) === wanted) ?? null;
  }

  const resolve: TypeCatalog['resolve'] = (ref, ctx) => {
    const dimensions = ref.dimensions ?? 0;
    const suffix = renderArgs(ref.args) + renderDimensions(dimensions);
    const descriptor = byName.get(canonical(ref.name)) ?? null;
    if (descriptor !== null) {
      return {
        ref,
        display: descriptor.id + suffix,
        status: 'builtin',
        descriptor,
        customType: null,
        args: mapArgs(descriptor, ref.args),
        dimensions,
        category: descriptor.category,
      };
    }
    const customType = findCustomType(ctx, ref);
    if (customType !== null) {
      return {
        ref,
        display: customType.name + suffix,
        status: 'user-defined',
        descriptor: null,
        customType,
        args: {},
        dimensions,
        category: 'user-defined',
      };
    }
    return {
      ref,
      display: ref.name + suffix,
      status: 'unknown',
      descriptor: null,
      customType: null,
      args: {},
      dimensions,
      category: 'other',
    };
  };

  /** `name`, `name(a)`, `name(a,b)`, `schema.name`, plus the array suffix. */
  function parseSpelling(raw: string): {
    name: string;
    args: (string | number)[] | undefined;
    dimensions: number;
  } {
    let text = raw.trim();
    let dimensions = 0;
    if (arraySyntax === 'suffix-brackets') {
      while (text.endsWith('[]')) {
        dimensions += 1;
        text = text.slice(0, -2).trimEnd();
      }
    }
    const open = text.indexOf('(');
    if (open === -1 || !text.endsWith(')')) return { name: text, args: undefined, dimensions };
    const inner = text.slice(open + 1, -1);
    const args = inner
      .split(',')
      .map((a) => a.trim())
      .filter((a) => a.length > 0)
      .map((a) => (/^-?\d+(\.\d+)?$/.test(a) ? Number(a) : a));
    return { name: text.slice(0, open), args: args.length > 0 ? args : undefined, dimensions };
  }

  const catalog: TypeCatalog = {
    descriptors,
    resolve,

    buildRef(input: BuildTypeRefInput, ctx: TypeResolutionContext): TypeRef {
      const parsed = parseSpelling(input.name);
      const args = input.args ?? parsed.args;
      const dimensions = input.dimensions ?? parsed.dimensions;
      const wanted = canonical(parsed.name);
      const descriptor = byName.get(wanted);
      const custom =
        descriptor === undefined
          ? ctx.customTypes.find((c) => canonical(c.name) === wanted)
          : undefined;
      const tail = {
        ...(args !== undefined && args.length > 0 ? { args: [...args] } : {}),
        ...(dimensions > 0 ? { dimensions } : {}),
      };
      if (descriptor !== undefined) return { name: descriptor.id, ...tail };
      if (custom !== undefined) return { name: custom.name, customTypeId: custom.id, ...tail };
      return { name: parsed.name, ...tail };
    },

    format(resolved: ResolvedType): string {
      // One renderer: `resolve` produced `display` with it, so this is idempotent by
      // construction — which is exactly what `types/resolve-format-roundtrip` asserts.
      return resolved.display;
    },

    areCompatible(a: ResolvedType, b: ResolvedType): boolean {
      if (a.dimensions !== b.dimensions) return false;
      const key = (t: ResolvedType): string =>
        t.customType === null ? canonical(t.ref.name) : `custom:${t.customType.id}`;
      const ka = key(a);
      const kb = key(b);
      if (ka === kb) return true;
      return groups.some((g) => g.has(ka) && g.has(kb));
    },

    listPickerOptions(ctx: TypeResolutionContext): readonly TypePickerOption[] {
      const builtins = descriptors.map((d): TypePickerOption => {
        const value: TypeRef = { name: d.id };
        return {
          value,
          label: d.displayName,
          group: CATEGORY_GROUPS[d.category],
          parameters: d.parameters,
          supportsArray: d.supportsArray,
          summary: d.summary,
          customTypeId: null,
          deprecated: d.deprecated,
        };
      });
      const userTypes = ctx.customTypes
        .filter((c) => userTypeGroups === undefined || c.kind in userTypeGroups)
        .map((c): TypePickerOption => {
          const value: TypeRef = { name: c.name, customTypeId: c.id };
          return {
            value,
            label: c.name,
            group: userTypeGroups?.[c.kind] ?? c.kind,
            parameters: [],
            supportsArray: arraySyntax !== 'none',
            summary: '',
            customTypeId: c.id,
            deprecated: false,
          };
        });
      return [...builtins, ...userTypes];
    },
  };

  return catalog;
}
