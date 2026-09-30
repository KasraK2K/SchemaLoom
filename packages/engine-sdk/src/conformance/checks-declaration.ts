import { expect } from 'vitest';
import { ENGINE_FEATURES, canIntrospect } from '../capabilities.js';
import { defineCapabilities } from '../define-capabilities.js';
import { FALLBACK_TERMINOLOGY, resolveTerm, type TermSubject } from '../terminology.js';
import type { ConformanceCheck } from './check.js';

/** identity, capabilities and terminology — everything an engine DECLARES about itself,
 *  checked against itself. No fixtures involved. */

const ID_SLUG = /^[a-z][a-z0-9-]*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

export const DECLARATION_CHECKS: readonly ConformanceCheck[] = [
  {
    id: 'identity/id-is-slug',
    run: ({ engine }) => {
      expect(engine.id).toMatch(ID_SLUG);
      expect(engine.displayName.length).toBeGreaterThan(0);
    },
  },
  {
    id: 'identity/version-is-semver',
    run: ({ engine }) => {
      // The PLUGIN's behaviour contract (§15), not the target server version.
      expect(engine.version).toMatch(SEMVER);
    },
  },
  {
    id: 'capabilities/schema-valid',
    run: ({ engine }) => {
      // Pure JSON: `GET /engines` serves this object and the browser caches it, so a
      // function, a Map or an `undefined` in it is a corruption that only shows up in
      // production. A JSON round trip is the exact test.
      const roundTripped = JSON.parse(JSON.stringify(engine.capabilities)) as unknown;
      expect(roundTripped).toEqual(engine.capabilities);
    },
  },
  {
    id: 'capabilities/features-total',
    run: ({ engine }) => {
      const features = engine.capabilities.features;
      expect(Object.keys(features).sort()).toEqual([...ENGINE_FEATURES].sort());
      expect(Object.values(features).every((v) => typeof v === 'boolean')).toBe(true);
    },
  },
  {
    id: 'capabilities/internally-consistent',
    run: ({ engine }) => {
      // `defineCapabilities` IS the §4.1 invariant table. Re-running it over the SHIPPED
      // object is what stops an engine hand-writing a capabilities literal that bypasses
      // the constructor, and it re-derives `typeCatalogSupportsArrays` from the catalog the
      // engine actually ships — so a catalog swapped out after the fact is caught here.
      const caps = engine.capabilities;
      const rebuilt = defineCapabilities({
        engineId: engine.id,
        features: caps.features,
        typeDescriptors: engine.typeCatalog.descriptors,
        namespaces: caps.namespaces,
        defaultNamespaceName: caps.defaultNamespaceName,
        entityKinds: caps.entityKinds,
        linkKinds: caps.linkKinds,
        indexTypes: caps.indexTypes,
        constraintKinds: caps.constraintKinds,
        customTypeKinds: caps.customTypeKinds,
        maxFieldDepth: caps.maxFieldDepth,
        identifiers: caps.identifiers,
        queryLanguage: caps.queryLanguage,
        importFormats: caps.importFormats,
        exportFormats: caps.exportFormats,
        connectionFields: caps.connectionFields,
      });
      expect(rebuilt).toEqual(caps);
    },
  },
  {
    id: 'capabilities/services-match-features',
    run: ({ engine }) => {
      // The check that stops an engine advertising a feature it has not implemented.
      // `defineCapabilities` cannot do it: it never sees the definition's services.
      expect(engine.capabilities.features.migrations).toBe(engine.migrationGenerator !== undefined);
      expect(engine.capabilities.features.queryValidation).toBe(
        engine.queryValidator !== undefined,
      );
      expect(canIntrospect(engine.capabilities)).toBe(engine.introspector !== undefined);
      const ids = engine.capabilities.connectionFields.map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
      // `aiProfile` deliberately has NO feature atom — its absence just hides the AI panel —
      // so there is nothing to agree with and nothing is asserted about it here.
    },
  },
  {
    id: 'terminology/covers-all-kinds',
    run: ({ engine }) => {
      const { capabilities: caps, terminology } = engine;
      const groups = [
        ['entityKind', caps.entityKinds.map((k) => k.id), terminology.entityKindTerms],
        ['linkKind', caps.linkKinds.map((k) => k.id), terminology.linkKindTerms],
        ['constraintKind', caps.constraintKinds.map((k) => k.id), terminology.constraintKindTerms],
        ['customTypeKind', caps.customTypeKinds.map((k) => k.id), terminology.customTypeKindTerms],
      ] as const;

      const missing: string[] = [];
      for (const [prefix, ids, map] of groups) {
        for (const id of ids) {
          // `resolveTerm` is TOTAL — it degrades to the core term — so asking it alone would
          // pass for every engine. The entry has to actually be there.
          if (!Object.hasOwn(map, id)) missing.push(`${prefix}:${id} has no terminology entry`);
          const term = resolveTerm(terminology, `${prefix}:${id}` satisfies TermSubject);
          if (term.one.length === 0 || term.other.length === 0) {
            missing.push(`${prefix}:${id} resolves to an empty term`);
          }
        }
      }
      for (const key of Object.keys(FALLBACK_TERMINOLOGY.terms)) {
        const term = resolveTerm(terminology, key as TermSubject);
        if (term.one.length === 0 || term.other.length === 0) {
          missing.push(`core term "${key}" is empty`);
        }
      }
      expect(missing).toEqual([]);
    },
  },
];
