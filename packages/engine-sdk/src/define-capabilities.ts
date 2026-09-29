import {
  ENGINE_FEATURES,
  anyLinkKindEnforced,
  type CapabilitiesInput,
  type EngineCapabilities,
  type EngineFeature,
} from './capabilities.js';
import { CapabilitiesContradictionError, EngineFeatureUnsupportedError } from './errors.js';
import type { EngineStaticFacet } from './definition.js';

function duplicates(ids: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

/**
 * Fills the feature record and the derived flags, freezes the result, and throws
 * `CapabilitiesContradictionError` on any violation of the §4.1 invariant table.
 *
 * The table is data, not fifteen hand-written `if`s, so the conformance check
 * `capabilities/internally-consistent` can re-run the identical list against a shipped object
 * and a hand-built capabilities literal cannot bypass the constructor.
 */
export function defineCapabilities(input: CapabilitiesInput): EngineCapabilities {
  // Destructured, not spread wholesale: `engineId` and `typeDescriptors` are constructor
  // arguments, not capabilities, and `typeDescriptors` would put the whole type catalog into
  // every GET /engines payload.
  const { engineId, typeDescriptors, features: declared, ...rest } = input;

  const features = Object.fromEntries(
    ENGINE_FEATURES.map((f) => [f, declared[f] ?? false]),
  ) as Record<EngineFeature, boolean>;

  const caps: EngineCapabilities = {
    ...rest,
    features,
    typeCatalogSupportsArrays: typeDescriptors.some((d) => d.supportsArray),
  };

  const fail = (rule: string, detail: string): never => {
    throw new CapabilitiesContradictionError(engineId, rule, detail);
  };

  // --- the §4.1 invariant table, in full and in order ---

  if (features.links !== caps.linkKinds.length > 0) {
    fail(
      'links-imply-kinds',
      `features.links=${String(features.links)} but linkKinds has ${String(caps.linkKinds.length)}`,
    );
  }

  if (features.indexes !== caps.indexTypes.length > 0) {
    fail(
      'indexes-imply-types',
      `features.indexes=${String(features.indexes)} but indexTypes has ${String(caps.indexTypes.length)}`,
    );
  }

  if (caps.indexTypes.length > 0 && caps.indexTypes.filter((i) => i.isDefault).length !== 1) {
    fail('one-default-index', 'exactly one indexType must have isDefault: true');
  }

  if (caps.entityKinds.length === 0) fail('entity-kinds-present', 'entityKinds is empty');
  const entityDupes = duplicates(caps.entityKinds.map((k) => k.id));
  if (entityDupes.length > 0)
    fail('entity-kinds-present', `duplicate entity kind ids: ${entityDupes.join(', ')}`);
  const codeDupes = duplicates(caps.entityKinds.map((k) => k.shortCode));
  if (codeDupes.length > 0)
    fail('entity-kinds-present', `duplicate shortCodes: ${codeDupes.join(', ')}`);
  for (const k of caps.entityKinds) {
    if (!/^[A-Z]{1,2}$/.test(k.shortCode)) {
      fail('entity-kinds-present', `shortCode "${k.shortCode}" must match /^[A-Z]{1,2}$/`);
    }
  }

  for (const [label, ids] of [
    ['linkKinds', caps.linkKinds.map((k) => k.id)],
    ['indexTypes', caps.indexTypes.map((k) => k.id)],
    ['constraintKinds', caps.constraintKinds.map((k) => k.id)],
    ['customTypeKinds', caps.customTypeKinds.map((k) => k.id)],
  ] as const) {
    const dupes = duplicates(ids);
    if (dupes.length > 0) fail('unique-kind-ids', `duplicate ${label} ids: ${dupes.join(', ')}`);
  }

  for (const k of caps.linkKinds) {
    if (k.cardinalities.length === 0) {
      fail('default-cardinality-allowed', `link kind "${k.id}" has no cardinalities`);
    }
    if (!k.cardinalities.includes(k.defaultCardinality)) {
      fail(
        'default-cardinality-allowed',
        `link kind "${k.id}" defaultCardinality ${k.defaultCardinality} is not in its cardinalities`,
      );
    }
  }

  if (features.referentialActions && !anyLinkKindEnforced(caps)) {
    fail(
      'referential-actions-need-enforcement',
      'features.referentialActions with no enforced link kind',
    );
  }

  const endpointKinds = new Set(
    caps.entityKinds.filter((k) => k.canBeLinkEndpoint).map((k) => k.id),
  );
  for (const k of caps.linkKinds) {
    for (const side of [k.allowedSourceEntityKinds, k.allowedTargetEntityKinds]) {
      if (side === '*') continue;
      for (const id of side) {
        if (!endpointKinds.has(id)) {
          fail(
            'link-endpoint-kinds-exist',
            `link kind "${k.id}" allows entity kind "${id}", which is absent or not canBeLinkEndpoint`,
          );
        }
      }
    }
  }

  if (caps.namespaces === 'none' && caps.defaultNamespaceName !== null) {
    fail('namespaces-none', 'namespaces: "none" requires defaultNamespaceName: null');
  }

  if (
    caps.namespaces !== 'none' &&
    (caps.defaultNamespaceName === null || caps.defaultNamespaceName.length === 0)
  ) {
    fail(
      'namespaces-some',
      `namespaces: "${caps.namespaces}" requires a non-empty defaultNamespaceName`,
    );
  }

  if (caps.maxFieldDepth < 1) fail('depth-sane', 'maxFieldDepth must be >= 1');
  if (caps.maxFieldDepth > 1 && !features.nestedFields) {
    fail('depth-sane', 'maxFieldDepth > 1 requires features.nestedFields');
  }

  for (const atom of ['expressionIndexes', 'includeColumns'] as const) {
    if (features[atom] && !features.indexes) {
      fail('index-features-need-indexes', `features.${atom} requires features.indexes`);
    }
  }

  const importDupes = duplicates(caps.importFormats.map((f) => f.id));
  if (importDupes.length > 0)
    fail('format-ids-unique', `duplicate importFormat ids: ${importDupes.join(', ')}`);
  const exportDupes = duplicates(caps.exportFormats.map((f) => f.id));
  if (exportDupes.length > 0)
    fail('format-ids-unique', `duplicate exportFormat ids: ${exportDupes.join(', ')}`);
  for (const f of caps.importFormats) {
    if (f.maxBytes <= 0) fail('format-ids-unique', `importFormat "${f.id}" needs maxBytes > 0`);
  }

  if (caps.queryLanguage.id.length === 0 || caps.queryLanguage.codeMirrorMode.length === 0) {
    fail('query-language-present', 'queryLanguage.id and codeMirrorMode must be non-empty');
  }

  if (caps.identifiers.maxLength < 1)
    fail('identifiers-sane', 'identifiers.maxLength must be >= 1');
  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(caps.identifiers.validUnquoted);
  } catch {
    compiled = null;
  }
  if (compiled === null) {
    fail(
      'identifiers-sane',
      `identifiers.validUnquoted is not a valid regex: ${caps.identifiers.validUnquoted}`,
    );
  }

  // `services-match-features` is NOT here: it compares the capabilities against the
  // EngineDefinition's optional services, which this constructor never sees. The conformance
  // suite (step 17) owns it, exactly as §4.1 says.

  return Object.freeze(caps);
}

/** Throws `EngineFeatureUnsupportedError`; used by API controllers before a write.
 *  There is deliberately no `hasFeature(caps, f)`: `features` is a total record, so
 *  `caps.features.indexes` is the read and a wrapper around a property access is ceremony. */
export function assertFeature(engine: EngineStaticFacet, feature: EngineFeature): void {
  if (!engine.capabilities.features[feature]) {
    throw new EngineFeatureUnsupportedError(engine.id, feature);
  }
}
