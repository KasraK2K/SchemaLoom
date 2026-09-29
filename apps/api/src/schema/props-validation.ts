import { UnprocessableEntityException } from '@nestjs/common';
import {
  parseEngineProps,
  type Diagnostic,
  type EnginePropsKind,
  type EngineStaticFacet,
} from '@schemaloom/engine-sdk';
import type { RedactedModel } from '@schemaloom/schema-model';
import type { SchemaOperation } from './ops';

/**
 * Doc 04 §8.6 rule 9, the `propsSchemas` stage: every bag a batch writes must parse under the
 * project's engine, or nothing downstream (exporter, migration generator, AI context) can read
 * it. 422 `engine.props-invalid` with the engine's diagnostics, before the version check.
 *
 * An update is re-checked only when it touches the bag, the `kind` that picks the schema, or an
 * index's columns. A rename is not blocked by props stored before this check existed.
 */
export function assertEngineProps(
  engine: EngineStaticFacet,
  ops: readonly SchemaOperation[],
  model: RedactedModel,
): void {
  const diagnostics: Diagnostic[] = [];
  const check = (kind: EnginePropsKind, subKind: string | null, value: unknown, id: string) => {
    const result = parseEngineProps(engine, kind, subKind, value);
    if (!result.ok) {
      for (const d of result.diagnostics) diagnostics.push({ ...d, target: { ...d.target, id } });
    }
  };
  const checkColumns = (indexId: string, columns: readonly { engineProps: unknown }[]) => {
    for (const column of columns) check('indexColumn', null, column.engineProps, indexId);
  };

  for (const op of ops) {
    if (op.op === 'create') {
      if (op.type === 'area') continue;
      check(op.type, subKindOf(op.type, op.object), op.object.engineProps, op.object.id);
      if (op.type === 'index') checkColumns(op.object.id, op.object.columns);
    } else if (op.op === 'update') {
      if (op.type === 'area') continue;
      const patch: { engineProps?: unknown; kind?: unknown; columns?: unknown } = op.patch;
      // Unknown id: `assertVersions` answers it with 404/409 next.
      const current = model.objects[op.type][op.id] as object | undefined;
      if (current === undefined) continue;
      if (patch.engineProps !== undefined || patch.kind !== undefined) {
        const merged = { ...current, ...op.patch } as { engineProps: unknown };
        check(op.type, subKindOf(op.type, merged), merged.engineProps, op.id);
      }
      if (op.type === 'index' && op.patch.columns !== undefined) {
        checkColumns(op.id, op.patch.columns);
      }
    }
  }

  if (diagnostics.length > 0) {
    throw new UnprocessableEntityException({ code: 'engine.props-invalid', diagnostics });
  }
}

/** `Entity.kind` / `Link.kind` / `CustomType.kind`; null for every other type, including a
 *  constraint, whose `kind` is not a props sub-kind (sdk props.ts). */
function subKindOf(type: EnginePropsKind, object: object): string | null {
  if (type !== 'entity' && type !== 'link' && type !== 'customType') return null;
  const kind = (object as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : null;
}
