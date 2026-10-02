import type { Diagnostic } from '@schemaloom/engine-sdk';
import { describe, expect, it } from 'vitest';
import {
  column,
  constraint,
  index,
  indexColumn,
  link,
  model,
  table,
  type ModelParts,
} from './fixture-model.js';
import { CODE } from './messages.js';
import { VALIDATOR } from './validator.js';

const run = (parts: ModelParts, serverVersion = 'MySQL 8.4'): readonly Diagnostic[] =>
  VALIDATOR.validate({ model: model(parts), context: { projectId: 'p1', serverVersion } });
const codes = (parts: ModelParts, serverVersion?: string) =>
  run(parts, serverVersion)
    .map((d) => d.code)
    .sort();

const orders = table({ id: 'e1', name: 'orders' });
const items = table({ id: 'e2', name: 'order_items' });

describe('MySQL validator', () => {
  it('allows one index name on two tables, and refuses PRIMARY for anything but the key', () => {
    const fields = [
      column({ id: 'f1', name: 'id', entityId: 'e1', type: { name: 'int' } }),
      column({ id: 'f2', name: 'id', entityId: 'e2', type: { name: 'int' } }),
    ];
    const idx = (id: string, entityId: string, fieldId: string, name = 'idx_id') =>
      index({ id, name, entityId, columns: [indexColumn({ fieldId })] });
    expect(
      codes({
        entities: [orders, items],
        fields,
        indexes: [idx('i1', 'e1', 'f1'), idx('i2', 'e2', 'f2')],
      }),
    ).toEqual([]);
    expect(
      codes({
        entities: [orders],
        fields: [fields[0]!],
        indexes: [idx('i1', 'e1', 'f1', 'PRIMARY')],
      }),
    ).toEqual([CODE.identifierReserved, CODE.reservedIndexName].sort());
  });

  it('enforces the AUTO_INCREMENT rules', () => {
    const ai = (id: string, type = 'bigint') =>
      column({
        id,
        name: id,
        entityId: 'e1',
        type: { name: type },
        engineProps: { autoIncrement: true },
      });
    expect(codes({ entities: [orders], fields: [ai('f1')] })).toEqual([
      CODE.autoIncrementNotIndexed,
    ]);
    expect(
      codes({
        entities: [orders],
        fields: [ai('f1', 'varchar')],
        constraints: [
          constraint({
            id: 'c1',
            name: 'PRIMARY',
            entityId: 'e1',
            kind: 'primaryKey',
            fieldIds: ['f1'],
          }),
        ],
      }),
    ).toEqual([CODE.autoIncrementNotInteger]);
  });

  it('needs a prefix to index TEXT, and values for ENUM', () => {
    expect(
      codes({
        entities: [orders],
        fields: [
          column({ id: 'f1', name: 'note', entityId: 'e1', type: { name: 'text' } }),
          column({ id: 'f2', name: 'state', entityId: 'e1', type: { name: 'enum' } }),
        ],
        indexes: [
          index({
            id: 'i1',
            name: 'idx_note',
            entityId: 'e1',
            columns: [indexColumn({ fieldId: 'f1' })],
          }),
        ],
      }),
    ).toEqual([CODE.indexNeedsPrefix, CODE.typeNeedsValues].sort());
  });

  it('flags MariaDB-only types on a MySQL target only', () => {
    const parts: ModelParts = {
      entities: [orders],
      fields: [column({ id: 'f1', name: 'ref', entityId: 'e1', type: { name: 'uuid' } })],
    };
    expect(codes(parts, 'MySQL 8.4')).toEqual([CODE.typeNotOnTarget]);
    expect(codes(parts, 'MariaDB 11.4')).toEqual([]);
  });

  it('requires a foreign key to match type and signedness', () => {
    const parts = (unsigned: boolean): ModelParts => ({
      entities: [orders, items],
      fields: [
        column({
          id: 'f1',
          name: 'id',
          entityId: 'e1',
          type: { name: 'bigint' },
          engineProps: { unsigned: true },
        }),
        column({
          id: 'f2',
          name: 'order_id',
          entityId: 'e2',
          type: { name: 'bigint' },
          engineProps: unsigned ? { unsigned: true } : {},
        }),
      ],
      links: [
        link({
          id: 'l1',
          name: 'fk',
          from: { entityId: 'e2', fieldIds: ['f2'] },
          to: { entityId: 'e1', fieldIds: ['f1'] },
        }),
      ],
    });
    expect(codes(parts(true))).toEqual([]);
    expect(codes(parts(false))).toEqual([CODE.linkTypeMismatch]);
  });
});
