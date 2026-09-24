import type { Id } from '../ids.js';
import { emptyCollections, type SchemaModel } from '../model.js';
import { brandRedacted, unwrapRaw, type RawSchemaModel, type RedactedModel } from './brand.js';
import { redactAreas, redactCustomTypes, redactNamespaces } from './containers.js';
import type { VisibilityContext } from './context.js';
import { redactConstraints } from './constraints.js';
import { redactEntities } from './entities.js';
import { redactFields } from './fields.js';
import { redactIndexes } from './indexes.js';
import { redactLinks } from './links.js';
import { planRedaction } from './plan.js';

/**
 * Doc 05 §8 — `VisibilityFilter`'s pure half, and the ONLY producer of a
 * `RedactedModel`.
 *
 * G2 (purity): no I/O, no clock, deterministic given `(raw, ctx)`.
 * G3 (idempotence): `redact(new RawSchemaModel(redact(raw, ctx)), ctx)` deep-equals
 *   `redact(raw, ctx)` — stubs, masks and blanked props all survive a second pass
 *   unchanged.
 * G5 (totality): every one of doc 04's eight `IR_OBJECT_TYPES` has an explicit rule
 *   below. The object literal is typed as `IrCollections`, so a ninth type added to the
 *   IR without a rule here is a compile error.
 *
 * Order matters in exactly two places: constraints and indexes are redacted BEFORE
 * entities, because an entity whose badges were dropped is marked; and namespaces are
 * redacted before custom types, which re-parent to the default namespace when theirs did
 * not survive.
 */
export function redact(raw: RawSchemaModel, ctx: VisibilityContext): RedactedModel {
  const model = unwrapRaw(raw);
  const head = {
    irVersion: model.irVersion,
    projectId: model.projectId,
    engineId: model.engineId,
    engineVersion: model.engineVersion,
    redacted: true,
  } as const;

  // §8.3, project-level metadata: kept if `ctx.canOpenProject`. A subject who cannot
  // open the project has already been 404'd by the guard; reaching here at all is a bug,
  // and an empty model is the fail-closed answer to it.
  if (!ctx.canOpenProject) return brandRedacted({ ...head, objects: emptyCollections() });

  const plan = planRedaction(model, ctx);

  const namespace = redactNamespaces(model, plan);
  const area = redactAreas(model, plan);
  const field = redactFields(model, plan);
  const constraint = redactConstraints(model, plan);
  const index = redactIndexes(model, plan);
  const link = redactLinks(model, plan);

  const entity = redactEntities(
    model,
    plan,
    new Set(Object.keys(area)),
    degradedEntityIds(model, constraint, index),
  );
  const customType = redactCustomTypes(model, plan, new Set(Object.keys(namespace)));

  const out: SchemaModel = {
    ...head,
    objects: { area, namespace, customType, entity, field, constraint, index, link },
  };
  return brandRedacted(out);
}

/** Entities that lost a constraint or an index, or had one blanked to a badge. */
function degradedEntityIds(
  model: SchemaModel,
  constraint: Readonly<Record<Id, { restricted?: true }>>,
  index: Readonly<Record<Id, { restricted?: true }>>,
): ReadonlySet<Id> {
  const out = new Set<Id>();
  for (const raw of Object.values(model.objects.constraint)) {
    const kept = constraint[raw.id];
    if (kept === undefined || kept.restricted === true) out.add(raw.entityId);
  }
  for (const raw of Object.values(model.objects.index)) {
    const kept = index[raw.id];
    if (kept === undefined || kept.restricted === true) out.add(raw.entityId);
  }
  return out;
}
