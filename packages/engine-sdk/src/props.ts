import type { z } from 'zod';
import { sortDiagnostics, type Diagnostic, type EnginePropsKind } from './diagnostics.js';
import type { EngineStaticFacet } from './definition.js';
import { IR_OBJECT_TYPES, type EngineProps, type IrObjectType } from './ir.js';

/**
 * Resolved per sub-kind, because a table and a view genuinely have different props, as do a
 * foreign key and an embedded-document link. `subKind` is `Entity.kind` / `Link.kind` /
 * `CustomType.kind`, and null for kinds that have no sub-kind.
 */
export type EnginePropsResolver = (subKind: string | null) => z.ZodType<EngineProps>;

export type EnginePropsSchemas = Readonly<Record<EnginePropsKind, EnginePropsResolver>>;

/** sugar for kinds with one schema */
export function constantProps(schema: z.ZodType<EngineProps>): EnginePropsResolver {
  return () => schema;
}

export type ParseEnginePropsResult =
  | { readonly ok: true; readonly props: EngineProps }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/** `EnginePropsKind` adds 'indexColumn', which is not an IR object; its diagnostics hang off
 *  the owning index, and 'project' is the SDK's "no IR object" target. */
function targetType(kind: EnginePropsKind): IrObjectType | 'project' {
  return (IR_OBJECT_TYPES as readonly string[]).includes(kind) ? (kind as IrObjectType) : 'index';
}

/**
 * Core's ONLY path to engine props validation, and the reason core never imports an engine:
 * the registry hands back an `EngineStaticFacet` and this function does the rest. Typed against
 * the STATIC facet, so the identical call runs in the browser (react-hook-form resolver) and in
 * the NestJS pipe.
 *
 * Every zod issue becomes a `Diagnostic` whose `target.propPath` is the zod path, so the
 * inspector highlights the exact input. `target.id` is the empty string: the caller is writing
 * one specific object and already knows its id (on a create there is not one yet), and the
 * pipe attaches it when it builds the 422 body.
 */
export function parseEngineProps(
  engine: EngineStaticFacet,
  kind: EnginePropsKind,
  subKind: string | null,
  value: unknown,
): ParseEnginePropsResult {
  const result = engine.propsSchemas[kind](subKind).safeParse(value);
  if (result.success) return { ok: true, props: result.data };

  const type = targetType(kind);
  const diagnostics = result.error.issues.map((issue): Diagnostic => {
    const propPath = issue.path.map((segment) => String(segment));
    return {
      code: `${engine.id}.props-invalid`,
      severity: 'error',
      params: { message: issue.message, path: propPath.join('.') },
      target: { type, id: '', propPath },
    };
  });
  return { ok: false, diagnostics: sortDiagnostics(diagnostics) };
}
