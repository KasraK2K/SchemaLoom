import type { Id, SchemaModel } from '@schemaloom/engine-sdk';
import type { OrmId } from './dialect.js';

/**
 * Phase 18 §2.1 — the model cut to the selected tables plus the ones they refer to by a visible
 * foreign key, so the ORM code for a selection compiles (a relation needs both sides). An
 * empty selection is the whole model; an id that isn't a visible table is ignored. Removing
 * objects from a redacted model can't reveal anything, so the result is still one: the spread
 * keeps the brand.
 */
export function subsetModel<T extends SchemaModel>(model: T, entityIds: readonly Id[]): T {
  if (entityIds.length === 0) return model;
  const { objects } = model;
  const visible = (id: Id) => {
    const entity = objects.entity[id];
    return entity !== undefined && entity.restricted !== true;
  };
  const selected = new Set(entityIds.filter(visible));
  const keep = new Set(selected);
  for (const link of Object.values(objects.link)) {
    if (link.restricted === true || !selected.has(link.from.entityId)) continue;
    if (visible(link.to.entityId)) keep.add(link.to.entityId);
  }
  const pick = <O extends object>(bag: Readonly<Record<Id, O>>, inside: (o: O) => boolean) =>
    Object.fromEntries(Object.entries(bag).filter(([, o]) => inside(o)));
  return {
    ...model,
    objects: {
      ...objects,
      entity: pick(objects.entity, (e) => keep.has(e.id)),
      field: pick(objects.field, (f) => keep.has(f.entityId)),
      constraint: pick(objects.constraint, (c) => keep.has(c.entityId)),
      index: pick(objects.index, (i) => keep.has(i.entityId)),
      link: pick(objects.link, (l) => keep.has(l.from.entityId) && keep.has(l.to.entityId)),
    },
  };
}

/**
 * Phase 18 §2.2 — what each ORM's code looks like, appended to the engine's code-mode
 * instructions. Core's, not an engine's: an ORM's query API is the same on every database.
 */
export const ORM_AI_GUIDANCE: Readonly<Record<OrmId, string>> = {
  prisma: [
    'The ORM is Prisma. Write TypeScript with Prisma Client: prisma.<model>.findMany / findFirst /',
    'create / update with where, select, include and orderBy, using the model and field names in',
    '<models> (not the database names they @map to). Use $queryRaw only when Prisma Client cannot',
    'express the query.',
  ].join('\n'),
  drizzle: [
    'The ORM is Drizzle. Write TypeScript with the query builder: db.select().from(table).where(…)',
    "with operators imported from 'drizzle-orm' (eq, and, gt, inArray, desc…), joins with",
    '.innerJoin / .leftJoin, or db.query.<table>.findMany({ with }) for relations. Import the',
    "tables from './schema' by the names <models> exports.",
  ].join('\n'),
  typeorm: [
    'The ORM is TypeORM. Write TypeScript with a repository (dataSource.getRepository(Entity))',
    "or dataSource.createQueryBuilder(Entity, 'alias'), using the entity classes and property names",
    "in <models>. Import the entities from './entities'.",
  ].join('\n'),
  django: [
    'The ORM is Django. Write Python with QuerySets on the model classes in <models>:',
    'Model.objects.filter / exclude / annotate / select_related / prefetch_related, with field',
    'lookups such as total__gt=100 and relations followed by their field names. Import the models',
    'from the app’s models module.',
  ].join('\n'),
};
