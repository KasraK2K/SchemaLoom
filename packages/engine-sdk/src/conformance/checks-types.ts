import { expect } from 'vitest';
import type { TypeRef } from '../ir.js';
import type { ConformanceCheck } from './check.js';
import { NO_SUCH_TYPE } from './context.js';

/** §5 — the type catalog. Every check here is over the catalog the engine ships, plus the
 *  user-defined types its reference model declares. */

export const TYPE_CHECKS: readonly ConformanceCheck[] = [
  {
    id: 'types/resolve-format-roundtrip',
    run: ({ engine, typeContext }) => {
      const catalog = engine.typeCatalog;
      expect(catalog.descriptors.length).toBeGreaterThan(0);

      const problems: string[] = [];
      const roundTrip = (spelling: string, dimensions: number, expectId: string): void => {
        const ref = catalog.buildRef({ name: spelling, dimensions }, typeContext);
        const resolved = catalog.resolve(ref, typeContext);
        if (resolved.status !== 'builtin' || resolved.descriptor?.id !== expectId) {
          problems.push(`${spelling} resolved as ${resolved.status}/${resolved.descriptor?.id ?? '-'}`);
          return;
        }
        const formatted = catalog.format(resolved);
        // `format(resolve(buildRef(x)))` must be a fixed point: the stored ref is canonical,
        // so feeding the rendered spelling back in cannot drift.
        const again = catalog.resolve(catalog.buildRef({ name: formatted }, typeContext), typeContext);
        if (catalog.format(again) !== formatted) {
          problems.push(`${spelling} formats to ${formatted} then to ${catalog.format(again)}`);
        }
      };

      for (const descriptor of catalog.descriptors) {
        roundTrip(descriptor.id, 0, descriptor.id);
        if (descriptor.supportsArray) roundTrip(descriptor.id, 1, descriptor.id);
      }
      expect(problems).toEqual([]);
    },
  },
  {
    id: 'types/aliases-resolve',
    run: ({ engine, typeContext }) => {
      const catalog = engine.typeCatalog;
      const problems: string[] = [];
      for (const descriptor of catalog.descriptors) {
        for (const alias of descriptor.aliases) {
          const resolved = catalog.resolve({ name: alias }, typeContext);
          if (resolved.status !== 'builtin' || resolved.descriptor?.id !== descriptor.id) {
            // Two descriptors claiming one alias land here: the catalog keeps the last, and
            // an imported column silently changes type.
            problems.push(
              `alias "${alias}" of ${descriptor.id} resolved to ${resolved.descriptor?.id ?? resolved.status}`,
            );
          }
        }
      }
      expect(problems).toEqual([]);
    },
  },
  {
    id: 'types/unknown-is-total',
    run: ({ engine, typeContext, fixtures }) => {
      const catalog = engine.typeCatalog;
      // Total means TOTAL: an exotic type imported from a database this engine has never
      // heard of must survive a round trip rather than throw or disappear.
      const exotic: TypeRef = { name: NO_SUCH_TYPE, args: [7, 'Point'] };
      const resolved = catalog.resolve(exotic, typeContext);
      expect(resolved.status).toBe('unknown');
      expect(resolved.descriptor).toBeNull();
      expect(resolved.customType).toBeNull();
      expect(resolved.ref).toEqual(exotic);
      expect(resolved.display).toContain(NO_SUCH_TYPE);
      expect(catalog.format(resolved)).toBe(resolved.display);

      // A ref naming a customTypeId that is not in the context is DANGLING, not a
      // by-name rebind onto a different type that happens to share the name (§5.3).
      const [anyCustomType] = Object.values(fixtures.referenceModel.objects.customType);
      if (anyCustomType !== undefined) {
        const dangling = catalog.resolve(
          { name: anyCustomType.name, customTypeId: '__conformance_no_such_custom_type__' },
          typeContext,
        );
        expect(dangling.status).toBe('unknown');
        expect(dangling.customType).toBeNull();
      }
    },
  },
  {
    id: 'types/picker-includes-custom-types',
    run: ({ engine, typeContext, fixtures }) => {
      const caps = engine.capabilities;
      const usableKinds = new Set(
        caps.customTypeKinds.filter((k) => k.usableAsFieldType).map((k) => k.id),
      );
      const expected = Object.values(fixtures.referenceModel.objects.customType).filter((c) =>
        usableKinds.has(c.kind),
      );
      // An engine that declares a usable custom-type kind and never exercises it in its
      // reference model would pass this check vacuously.
      if (usableKinds.size > 0) expect(expected.length).toBeGreaterThan(0);

      const options = engine.typeCatalog.listPickerOptions(typeContext);
      const offered = new Set(options.map((o) => o.customTypeId).filter((id) => id !== null));
      expect(expected.filter((c) => !offered.has(c.id)).map((c) => c.name)).toEqual([]);
      // ...and the builtins are still in the same list.
      expect(options.some((o) => o.customTypeId === null)).toBe(true);
    },
  },
];
