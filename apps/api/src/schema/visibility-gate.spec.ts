import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { redact } from '@schemaloom/schema-model';
import { describe, expect, it } from 'vitest';
import { fakePrisma } from './fake-prisma';
import {
  PROJECT,
  baseStore,
  entityRow,
  fieldRow,
  linkEndpointRow,
  linkRow,
  storeContext,
} from './fixture';
import type { SchemaOperation } from './ops';
import { SchemaLoader } from './schema-loader.service';
import { assertOpsVisible } from './visibility-gate';

/**
 * Doc 04 §8.6 rule 1 — visibility BEFORE versions.
 *
 * The models here are produced by the real `redact()`, not hand-built, because the rule
 * is a statement about what redaction leaves behind: a stub entity is present and
 * marked, a hidden field is gone entirely, and the gate has to answer differently for
 * the two.
 */
const store = baseStore({
  entity: [entityRow('ent_orders'), entityRow('ent_payroll'), entityRow('ent_vault')],
  field: [
    fieldRow('fld_total', 'ent_orders'),
    fieldRow('fld_salary', 'ent_orders', { position: 1, isRestricted: true }),
    fieldRow('fld_pay', 'ent_payroll'),
  ],
  // A surviving link into `ent_payroll` is what turns it into a STUB rather than
  // dropping it: the difference between 403 and 404 below.
  link: [linkRow('lnk_p', 'ent_orders', 'ent_payroll')],
  linkEndpoint: [linkEndpointRow('lnk_p', 'fld_total', 'fld_pay')],
});

async function redactedFor(over: Parameters<typeof storeContext>[1]) {
  const prisma = fakePrisma(store);
  const raw = await new SchemaLoader(prisma.client).load(PROJECT);
  return redact(raw, storeContext(store, over));
}

const update = (type: string, id: string, expectedVersion = 999): SchemaOperation =>
  ({ op: 'update', type, id, expectedVersion, patch: { name: 'x' } }) as SchemaOperation;

describe('assertOpsVisible', () => {
  it('lets an op through when the target is fully visible', async () => {
    const model = await redactedFor({});
    expect(() => {
      assertOpsVisible(model, [update('entity', 'ent_orders')]);
    }).not.toThrow();
  });

  it('reports NOT FOUND — not a version conflict — for an object the caller cannot see', async () => {
    // `ent_vault` is invisible and nothing surviving references it, so redaction drops
    // it. A deliberately wrong `expectedVersion` must not come back as "actual 7": that
    // would confirm the table exists and say how often it has been edited.
    const model = await redactedFor({
      visibleEntityIds: new Set(['ent_orders', 'ent_payroll']),
      restrictedOkEntityIds: new Set(['ent_orders']),
    });
    expect(() => {
      assertOpsVisible(model, [update('entity', 'ent_vault', 0)]);
    }).toThrow(NotFoundException);
  });

  it('reports NOT FOUND for an id that does not exist at all — the same answer', async () => {
    const model = await redactedFor({});
    let thrown: unknown;
    try {
      assertOpsVisible(model, [update('entity', 'ent_never', 0)]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect((thrown as NotFoundException).getResponse()).toMatchObject({ code: 'not_found' });
  });

  it('403s a STUB: the object is disclosed, so pretending it is absent would be a lie', async () => {
    const model = await redactedFor({
      visibleEntityIds: new Set(['ent_orders']),
      restrictedOkEntityIds: new Set(['ent_orders']),
    });
    expect(model.objects.entity.ent_payroll?.restricted).toBe(true);
    expect(() => {
      assertOpsVisible(model, [update('entity', 'ent_payroll', 0)]);
    }).toThrow(ForbiddenException);
  });

  it('403s a MASKED field — the whole-collection-patch hazard is refused here', async () => {
    const model = await redactedFor({ restrictedOkEntityIds: new Set() });
    expect(model.objects.field.fld_salary?.restricted).toBe(true);
    expect(() => {
      assertOpsVisible(model, [update('field', 'fld_salary', 0)]);
    }).toThrow(ForbiddenException);
  });

  it('404s a field hidden by the project setting rather than masked', async () => {
    const model = await redactedFor({
      restrictedFieldMode: 'hide',
      restrictedOkEntityIds: new Set(),
    });
    expect(model.objects.field.fld_salary).toBeUndefined();
    expect(() => {
      assertOpsVisible(model, [update('field', 'fld_salary', 0)]);
    }).toThrow(NotFoundException);
  });

  it('refuses the whole batch on the first bad target, before any version is looked at', async () => {
    const model = await redactedFor({ restrictedOkEntityIds: new Set() });
    expect(() => {
      assertOpsVisible(model, [
        update('entity', 'ent_orders'),
        update('field', 'fld_salary'),
        update('entity', 'ent_orders'),
      ]);
    }).toThrow(ForbiddenException);
  });

  it('skips creates: they name no existing target', async () => {
    const model = await redactedFor({});
    expect(() => {
      assertOpsVisible(model, [
        {
          op: 'create',
          type: 'namespace',
          object: { id: 'ns_new', name: 'n', engineProps: {}, isDefault: false },
        },
      ]);
    }).not.toThrow();
  });
});
