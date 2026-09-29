import type { HttpException } from '@nestjs/common';
import { constantProps, type EngineStaticFacet } from '@schemaloom/engine-sdk';
import type { RedactedModel } from '@schemaloom/schema-model';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ENGINE_MANIFEST } from '../engines/engines.manifest';
import type { SchemaOperation } from './ops';
import { assertEngineProps } from './props-validation';

/** Doc 04 §8.6 rule 9, the `propsSchemas` stage, against a small strict engine. */

const STRICT = z.object({}).strict();
const engine = {
  id: 'testsql',
  propsSchemas: {
    namespace: constantProps(STRICT),
    customType: constantProps(STRICT),
    entity: (subKind: string | null) =>
      subKind === 'table' ? z.object({ fillfactor: z.number().int().optional() }).strict() : STRICT,
    field: constantProps(z.object({ default: z.string().optional() }).strict()),
    // If a constraint's `kind` were taken as a sub-kind, `primaryKey` would pick this schema.
    constraint: (subKind: string | null) =>
      subKind === null ? z.object({ expression: z.string().optional() }).strict() : z.never(),
    index: constantProps(STRICT),
    indexColumn: constantProps(z.object({ opclass: z.string().optional() }).strict()),
    link: constantProps(STRICT),
  },
} as unknown as EngineStaticFacet;

const model = {
  objects: {
    entity: { ent_1: { id: 'ent_1', kind: 'table', engineProps: { fillfactor: 70 } } },
    field: { fld_1: { id: 'fld_1', engineProps: { junk: true } } },
    index: {},
  },
} as unknown as RedactedModel;

/** A batch as a callback, for `expect(...).toThrow()` and `rejection(...)`. */
const write =
  (...list: unknown[]) =>
  (): void => {
    assertEngineProps(engine, list as SchemaOperation[], model);
  };
const create = (type: string, object: object) => ({ op: 'create', type, object });
const update = (type: string, id: string, patch: object) => ({
  op: 'update',
  type,
  id,
  expectedVersion: 0,
  patch,
});

function rejection(run: () => void): { status: number; body: Record<string, unknown> } {
  try {
    run();
  } catch (error) {
    const e = error as HttpException;
    return { status: e.getStatus(), body: e.getResponse() as Record<string, unknown> };
  }
  throw new Error('expected a 422');
}

describe('assertEngineProps (doc 04 §8.6 rule 9)', () => {
  it('rejects a create whose bag the engine does not model, naming the object', () => {
    const { status, body } = rejection(
      write(create('field', { id: 'fld_new', engineProps: { bogus: 1 } })),
    );
    expect(status).toBe(422);
    expect(body.code).toBe('engine.props-invalid');
    expect(body.diagnostics).toEqual([
      expect.objectContaining({
        code: 'testsql.props-invalid',
        target: expect.objectContaining({ type: 'field', id: 'fld_new' }),
      }),
    ]);
  });

  it('accepts valid bags, and resolves the schema by entity kind', () => {
    expect(
      write(
        create('field', { id: 'f', engineProps: { default: 'now()' } }),
        create('entity', { id: 'e', kind: 'table', engineProps: { fillfactor: 80 } }),
        create('constraint', { id: 'c', kind: 'primaryKey', engineProps: {} }),
      ),
    ).not.toThrow();
    // `fillfactor` is a table prop; a view does not model it.
    expect(
      rejection(write(create('entity', { id: 'v', kind: 'view', engineProps: { fillfactor: 80 } })))
        .status,
    ).toBe(422);
  });

  it("checks an index's columns", () => {
    const index = (engineProps: object) =>
      create('index', { id: 'ix', engineProps: {}, columns: [{ ordinal: 0, engineProps }] });
    expect(write(index({ opclass: 'text_ops' }))).not.toThrow();
    expect(rejection(write(index({ nope: 1 }))).status).toBe(422);
  });

  it('does not re-check a rename, even over props stored before this check existed', () => {
    expect(write(update('field', 'fld_1', { name: 'renamed' }))).not.toThrow();
  });

  it('re-checks the stored bag when the kind that picks the schema changes', () => {
    // A table's `fillfactor` is invalid on a view.
    expect(rejection(write(update('entity', 'ent_1', { kind: 'view' }))).status).toBe(422);
    expect(write(update('entity', 'ent_1', { kind: 'view', engineProps: {} }))).not.toThrow();
  });

  it('uses the real PostgreSQL engine the same way', () => {
    const postgres = ENGINE_MANIFEST[0] as EngineStaticFacet;
    const run = (object: object) => (): void => {
      assertEngineProps(postgres, [create('field', object)] as SchemaOperation[], model);
    };
    expect(run({ id: 'f1', engineProps: {} })).not.toThrow();
    expect(rejection(run({ id: 'f2', engineProps: { notAPostgresProp: 1 } })).status).toBe(422);
  });
});
