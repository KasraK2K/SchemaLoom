import { RawSchemaModel, redact } from '@schemaloom/schema-model';
import { describe, expect, it } from 'vitest';
import { fakePrisma } from './fake-prisma';
import {
  PROJECT,
  baseStore,
  entityRow,
  fieldRow,
  indexColumnRow,
  indexRow,
  linkEndpointRow,
  linkRow,
  storeContext,
} from './fixture';
import { SchemaLoader } from './schema-loader.service';

/**
 * Doc 04 §8.1 — the read path. Two properties, both of which a reviewer cannot see by
 * reading the code once: the scans really are concurrent, and the thing that comes back
 * really is unreachable without `redact`.
 */
describe('SchemaLoader', () => {
  const store = baseStore({
    entity: [entityRow('ent_orders'), entityRow('ent_users')],
    field: [
      fieldRow('fld_total', 'ent_orders', { dataType: 'numeric', typeArgs: [10, 2], position: 0 }),
      fieldRow('fld_user', 'ent_orders', { position: 1 }),
      fieldRow('fld_id', 'ent_users'),
    ],
    schemaIndex: [indexRow('idx_total', 'ent_orders')],
    schemaIndexColumn: [indexColumnRow('idx_total', 'fld_total', { isInclude: true })],
    link: [linkRow('lnk_orders_users', 'ent_orders', 'ent_users')],
    linkEndpoint: [linkEndpointRow('lnk_orders_users', 'fld_user', 'fld_id')],
  });

  it('issues every project_id scan in parallel, not one after another', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prisma = fakePrisma(store, { gate });

    // Deliberately NOT awaited: the assertion is that all twelve scans were already in
    // flight before any of them could resolve. Awaiting them one at a time would turn one
    // round trip into twelve on a project the canvas opens on every page load.
    const pending = new SchemaLoader(prisma.client).load(PROJECT);

    const scans = prisma.names().filter((n) => n.endsWith('.findMany'));
    expect(scans).toHaveLength(12);
    expect(new Set(scans).size).toBe(12);

    release();
    await pending;
  });

  it('scopes every scan to the project (C6)', async () => {
    const prisma = fakePrisma(store);
    await new SchemaLoader(prisma.client).load(PROJECT);

    for (const call of prisma.calls.filter((c) => c.method === 'findMany')) {
      expect(call.args.where).toMatchObject({ projectId: PROJECT });
    }
  });

  it('returns a RawSchemaModel whose payload is unreachable without redact()', async () => {
    const prisma = fakePrisma(store);
    const raw = await new SchemaLoader(prisma.client).load(PROJECT);

    expect(raw).toBeInstanceOf(RawSchemaModel);
    // Not a "nice error" — it is the guarantee. A handler that serialises the loader
    // result by accident fails loudly instead of shipping an unredacted model.
    expect(() => JSON.stringify(raw)).toThrow('raw_ir_escaped');
    expect(Object.keys(raw)).toHaveLength(0);

    const model = redact(raw, storeContext(store));
    expect(model.redacted).toBe(true);
    expect(Object.keys(model.objects.entity)).toHaveLength(2);
  });

  it('maps the columns doc 04 §8.1 renames, not just the ones that match', async () => {
    const prisma = fakePrisma(store);
    const model = redact(await new SchemaLoader(prisma.client).load(PROJECT), storeContext(store));

    const total = model.objects.field.fld_total;
    expect(total?.type).toMatchObject({ name: 'numeric', args: [10, 2] });
    // `fields.position` is the IR's `ordinal`; there is no `depth` column to map.
    expect(total?.ordinal).toBe(0);
    // `index_columns.is_include` is the IR's `role` (doc 02 delta D2).
    expect(model.objects.index.idx_total?.columns[0]?.role).toBe('include');
    // `many_to_one` is the IR's 'N:1'.
    expect(model.objects.link.lnk_orders_users?.cardinality).toBe('N:1');
    expect(model.objects.link.lnk_orders_users?.from.fieldIds).toEqual(['fld_user']);
  });

  it('404s a soft-deleted project rather than assembling an empty model', async () => {
    const prisma = fakePrisma(baseStore({ project: [] }));
    await expect(new SchemaLoader(prisma.client).load(PROJECT)).rejects.toThrow();
  });
});
