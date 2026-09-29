import type { EngineStaticFacet } from '@schemaloom/engine-sdk/ui';
import type { SchemaModel } from '@schemaloom/schema-model';
import { beforeAll, describe, expect, it } from 'vitest';
import { engineFacets } from '@/engines';
import { cardinalityFor, checkConnection, explainCheck, isValidConnection } from './connect';
import { fieldHandleId } from './handles';
import {
  CUSTOMERS,
  CUSTOMER_ID,
  ORDERS,
  ORDER_CUSTOMER_ID,
  ORDER_NOTE,
  SECRET,
  fixtureModel,
} from './model-fixture';

/**
 * The canvas and the server must never disagree about what is legal, which is why the
 * drag goes through the SDK's shared `checkLink` and not a canvas-local rule table. These
 * tests run it against the REAL PostgreSQL facet, so a rule change in
 * `capabilities.linkKinds` shows up here rather than as a drag the API later refuses.
 */
let facet: EngineStaticFacet;
let model: SchemaModel;

beforeAll(async () => {
  await import('@/engines/register');
  facet = await engineFacets.load('postgresql');
  model = fixtureModel();
});

const drag = (sourceField: string, targetField: string) => ({
  source: model.objects.field[sourceField]?.entityId ?? '',
  target: model.objects.field[targetField]?.entityId ?? '',
  sourceHandle: fieldHandleId(sourceField, 'source'),
  targetHandle: fieldHandleId(targetField, 'target'),
});

describe('mid-drag link validation', () => {
  it('accepts a uuid foreign key onto a primary key', () => {
    const check = checkConnection({ engine: facet, model }, drag(ORDER_CUSTOMER_ID, CUSTOMER_ID));
    expect(check.ok).toBe(true);
    expect(check.linkKindId).not.toBeNull();
  });

  it('refuses a drag between incompatible types', () => {
    const check = checkConnection({ engine: facet, model }, drag(ORDER_NOTE, CUSTOMER_ID));
    expect(check.ok).toBe(false);
    expect(isValidConnection({ engine: facet, model }, drag(ORDER_NOTE, CUSTOMER_ID))).toBe(false);
  });

  it('renders the refusal through the engine terminology rather than as prose', () => {
    const check = checkConnection({ engine: facet, model }, drag(ORDER_NOTE, CUSTOMER_ID));
    const sentences = explainCheck(facet, check);
    expect(sentences.length).toBeGreaterThan(0);
    expect(sentences.every((sentence) => sentence.length > 0)).toBe(true);
  });

  it('suggests a cardinality the chosen kind actually allows', () => {
    const check = checkConnection({ engine: facet, model }, drag(ORDER_CUSTOMER_ID, CUSTOMER_ID));
    expect(check.allowedCardinalities).toContain(cardinalityFor(check));
  });

  it('treats a handle with no field id as an endpoint with no columns', () => {
    const check = checkConnection(
      { engine: facet, model },
      {
        source: ORDERS,
        target: CUSTOMERS,
        sourceHandle: 'node:source',
        targetHandle: 'node:target',
      },
    );
    // Incomplete, not illegal: §7 says the validator reports incompleteness, not the
    // drag checker, and a user may draw the edge before picking columns.
    expect(check.ok).toBe(true);
  });

  it('says nothing about an endpoint the viewer cannot see (§7.1)', () => {
    // A redacted endpoint must not produce an error naming an object the viewer was never
    // shown. The server re-evaluates the real rules on the write regardless.
    const check = checkConnection(
      { engine: facet, model },
      { source: ORDERS, target: SECRET, sourceHandle: 'node:source', targetHandle: 'node:target' },
    );
    expect(check.reasons).toEqual([]);
  });
});
