import { expect } from 'vitest';
import { IR_OBJECT_TYPES, type Id, type IrBase, type LinkEndpoint } from '../ir.js';
import { checkLink } from '../links.js';
import type { ConformanceCheck } from './check.js';

/** §7 link rules. `capabilities.linkKinds` IS the rule set and `checkLink` evaluates it, so
 *  these two checks are where a capabilities declaration meets the engine's own model. */

export const LINK_CHECKS: readonly ConformanceCheck[] = [
  {
    id: 'links/descriptors-consistent',
    run: ({ engine, fixtures }) => {
      const model = fixtures.referenceModel;
      const links = Object.values(model.objects.link);
      // An engine claiming `features.links` whose reference model has none is claiming
      // something nothing tests.
      if (engine.capabilities.features.links) expect(links.length).toBeGreaterThan(0);

      const problems: string[] = [];
      for (const link of links) {
        const result = checkLink({
          engine,
          model,
          linkKindId: link.kind,
          source: link.from,
          target: link.to,
        });
        // The check that catches a capabilities declaration contradicting the engine's own
        // reference schema — an `allowedTargetEntityKinds` that excludes the kind the model
        // actually links to, a `requireTypeCompatibility` the catalog will not grant.
        if (!result.ok || result.linkKindId !== link.kind) {
          problems.push(
            `${link.id} (${link.kind}): ${result.reasons.map((r) => r.code).join(', ') || 'kind mismatch'}`,
          );
        }
        if (result.ok && !result.allowedCardinalities.includes(link.cardinality)) {
          problems.push(`${link.id} carries cardinality ${link.cardinality}, which its kind forbids`);
        }
      }
      expect(problems).toEqual([]);
    },
  },
  {
    id: 'links/tolerates-redacted',
    run: ({ engine, fixtures }) => {
      const model = fixtures.redactedModel;
      expect(model.redacted).toBe(true);

      // The fixture has to actually contain redaction, or this check tests nothing. Doc 04
      // §10.2's shapes all carry `restricted` or `propsRedacted` somewhere.
      const marked = IR_OBJECT_TYPES.some((type) => {
        const bag: Record<Id, IrBase> = model.objects[type];
        return Object.values(bag).some((o) => o.restricted === true || o.propsRedacted === true);
      });
      expect(marked).toBe(true);

      const problems: string[] = [];
      for (const link of Object.values(model.objects.link)) {
        // §7.1: on a redacted model an endpoint the viewer cannot see must never produce an
        // error ABOUT an object they cannot see. `ok: true` here is not "this link is legal"
        // — the viewer cannot write, and the server re-evaluates against the true model.
        const result = checkLink({
          engine,
          model,
          linkKindId: link.kind,
          source: link.from,
          target: link.to,
        });
        if (!result.ok || result.reasons.length > 0) {
          problems.push(`${link.id}: ${result.reasons.map((r) => r.code).join(', ') || 'not ok'}`);
        }
      }
      expect(problems).toEqual([]);

      // ...and it must not throw on an endpoint whose field ids are simply gone, which is
      // what a both-sides `fieldIds` clear leaves behind for anything that kept a copy.
      const [entity] = Object.values(model.objects.entity);
      if (entity !== undefined) {
        const absent: LinkEndpoint = {
          entityId: entity.id,
          fieldIds: ['__conformance_absent_field__'],
        };
        expect(() =>
          checkLink({ engine, model, linkKindId: null, source: absent, target: absent }),
        ).not.toThrow();
      }
    },
  },
];
