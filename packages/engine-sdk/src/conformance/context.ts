import type { EngineDefinition, EngineStaticFacet } from '../definition.js';
import type { Diagnostic, EngineContext, EnginePropsKind } from '../diagnostics.js';
import { IR_OBJECT_TYPES, type Id, type IrBase, type IrObjectType, type ObjectRefs, type SchemaModel } from '../ir.js';
import type { TypeResolutionContext } from '../type-catalog.js';
import type { ConformanceFixtures } from './types.js';

/**
 * `EngineDefinition.validator` is typed `unknown` until build-order step 8 lands
 * `EngineValidator` on the SDK. The suite still has to call it, so it narrows structurally —
 * the shape is §8's, verbatim, and the day the real interface lands this alias is deleted.
 */
export interface ConformanceValidator {
  validate(input: {
    readonly model: SchemaModel;
    readonly objectIds?: readonly string[];
    readonly context: EngineContext;
  }): readonly Diagnostic[];
}

export function asValidator(value: unknown): ConformanceValidator | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { readonly validate?: unknown };
  return typeof candidate.validate === 'function' ? (value as ConformanceValidator) : null;
}

export interface CheckContext {
  readonly engine: EngineDefinition;
  readonly fixtures: ConformanceFixtures;
  /** built from `referenceModel`, so a user-defined type in a fixture actually resolves */
  readonly typeContext: TypeResolutionContext;
  readonly engineContext: EngineContext;
  readonly validator: ConformanceValidator | null;
}

export function createCheckContext(
  engine: EngineDefinition,
  fixtures: ConformanceFixtures,
): CheckContext {
  const model = fixtures.referenceModel;
  const defaultNamespace = Object.values(model.objects.namespace).find((n) => n.isDefault);
  return {
    engine,
    fixtures,
    typeContext: {
      customTypes: Object.values(model.objects.customType),
      namespaceName: defaultNamespace?.name ?? engine.capabilities.defaultNamespaceName,
    },
    engineContext: { projectId: model.projectId, serverVersion: model.engineVersion },
    validator: asValidator(engine.validator),
  };
}

/** The IR is JSON by construction (doc 04 §1.1), so this is the whole clone. */
export function cloneModel(model: SchemaModel): SchemaModel {
  return JSON.parse(JSON.stringify(model)) as SchemaModel;
}

function mapValues<T>(bag: Record<Id, T>, f: (value: T) => T): Record<Id, T> {
  return Object.fromEntries(Object.entries(bag).map(([id, value]) => [id, f(value)]));
}

/**
 * A deterministic broken copy of the reference model, built only from CAPABILITIES so it
 * breaks any engine's rules rather than PostgreSQL's: every entity takes the same
 * over-long name (too long, and duplicated), every field takes a type no catalog can
 * resolve. `validator/deterministic` needs a model that produces diagnostics — three
 * identical empty arrays prove nothing.
 */
export function brokenCopy(engine: EngineStaticFacet, model: SchemaModel): SchemaModel {
  const tooLong = 'z'.repeat(engine.capabilities.identifiers.maxLength + 5);
  const clone = cloneModel(model);
  clone.objects.entity = mapValues(clone.objects.entity, (e) => ({ ...e, name: tooLong }));
  clone.objects.field = mapValues(clone.objects.field, (f) => ({
    ...f,
    type: { name: NO_SUCH_TYPE },
  }));
  return clone;
}

/** A name no engine's type catalog may claim. Shared so `types/unknown-is-total` and
 *  `brokenCopy` cannot drift onto a name one engine happens to define. */
export const NO_SUCH_TYPE = '__conformance_no_such_type__';

/** A props key no engine may accept — `props/schemas-are-strict` is the whole point. */
export const NO_SUCH_PROP = '__conformance_unknown_prop__';

/** `EnginePropsKind` is `Exclude<IrObjectType, 'area'> | 'indexColumn'` and has no runtime
 *  list of its own; deriving it from `IR_OBJECT_TYPES` keeps the two in step. */
export const PROPS_KINDS: readonly EnginePropsKind[] = [
  ...IR_OBJECT_TYPES.filter((t): t is Exclude<IrObjectType, 'area'> => t !== 'area'),
  'indexColumn',
];

/** Every sub-kind the engine declares for one props kind, plus `null` — which resolves the
 *  "no sub-kind" schema and must be strict too. */
export function subKindsOf(
  engine: EngineStaticFacet,
  kind: EnginePropsKind,
): readonly (string | null)[] {
  const caps = engine.capabilities;
  const declared =
    kind === 'entity'
      ? caps.entityKinds.map((k) => k.id)
      : kind === 'link'
        ? caps.linkKinds.map((k) => k.id)
        : kind === 'constraint'
          ? caps.constraintKinds.map((k) => k.id)
          : kind === 'customType'
            ? caps.customTypeKinds.map((k) => k.id)
            : [];
  return [null, ...declared];
}

/** Write `refs` onto whichever collection holds `id`, the way core does after a write.
 *  Returns false when the id is not in the model at all. */
export function seatRefs(model: SchemaModel, id: Id, refs: ObjectRefs): boolean {
  for (const type of IR_OBJECT_TYPES) {
    const bag: Record<Id, IrBase> = model.objects[type];
    const found = bag[id];
    if (found !== undefined) {
      bag[id] = { ...found, refs };
      return true;
    }
  }
  return false;
}

/** Drop `refs` from whichever collection holds `id` — the control half of
 *  `validator/expression-reference-stale`. */
export function clearRefs(model: SchemaModel, id: Id): void {
  for (const type of IR_OBJECT_TYPES) {
    const bag: Record<Id, IrBase> = model.objects[type];
    const found = bag[id];
    if (found !== undefined) {
      const { refs: _refs, ...rest } = found;
      bag[id] = rest;
      return;
    }
  }
}
