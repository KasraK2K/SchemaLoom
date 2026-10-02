import type {
  Constraint,
  EngineProps,
  Entity,
  Field,
  Id,
  Index,
  IndexColumn,
  Link,
  Namespace,
  SchemaModel,
  TypeRef,
} from '@schemaloom/engine-sdk';
import { normalizeName } from './normalize-name.js';

/**
 * The IR under construction during an import, plus the name lookups that let one statement
 * refer to another's objects (an `ALTER TABLE … ADD FOREIGN KEY` to a table defined later).
 * A project is one database (design Q4), so there is one unnamed default namespace and names
 * are looked up by table name alone.
 */
export class ImportModel {
  readonly namespace: Record<Id, Namespace> = {};
  readonly entity: Record<Id, Entity> = {};
  field: Record<Id, Field> = {};
  readonly constraint: Record<Id, Constraint> = {};
  readonly index: Record<Id, Index> = {};
  readonly link: Record<Id, Link> = {};

  private readonly namespaceId: Id;
  private readonly entityByName = new Map<string, Entity>();
  private readonly fieldsByEntity = new Map<Id, Map<string, Field>>();
  private readonly ordinals = new Map<Id, number>();

  constructor(
    private readonly newId: () => Id,
    defaultNamespaceName: string,
  ) {
    this.namespaceId = newId();
    this.namespace[this.namespaceId] = {
      id: this.namespaceId,
      name: defaultNamespaceName,
      version: 0,
      engineProps: {},
      isDefault: true,
    };
  }

  addEntity(name: string, kind: string, engineProps: EngineProps): Entity {
    const created: Entity = {
      id: this.newId(),
      name,
      version: 0,
      engineProps,
      namespaceId: this.namespaceId,
      kind,
      areaId: null,
      position: { x: 0, y: 0 },
      color: null,
      doc: null,
    };
    this.entity[created.id] = created;
    this.entityByName.set(normalizeName(name), created);
    this.fieldsByEntity.set(created.id, new Map());
    this.ordinals.set(created.id, 0);
    return created;
  }

  findEntity(name: string): Entity | undefined {
    return this.entityByName.get(normalizeName(name));
  }

  /** mysqldump writes a placeholder view first, then the real one: the second replaces it. */
  replaceView(entity: Entity, engineProps: EngineProps): Entity {
    const gone = new Set(
      [...(this.fieldsByEntity.get(entity.id)?.values() ?? [])].map((f) => f.id),
    );
    this.field = Object.fromEntries(Object.entries(this.field).filter(([id]) => !gone.has(id)));
    this.fieldsByEntity.set(entity.id, new Map());
    this.ordinals.set(entity.id, 0);
    const next: Entity = { ...entity, engineProps };
    this.entity[entity.id] = next;
    this.entityByName.set(normalizeName(entity.name), next);
    return next;
  }

  setEntityProps(entity: Entity, engineProps: EngineProps): void {
    const next: Entity = { ...entity, engineProps };
    this.entity[entity.id] = next;
    this.entityByName.set(normalizeName(entity.name), next);
  }

  addField(
    entity: Entity,
    name: string,
    type: TypeRef,
    isNullable: boolean,
    engineProps: EngineProps,
  ): Field {
    const ordinal = this.ordinals.get(entity.id) ?? 0;
    this.ordinals.set(entity.id, ordinal + 1);
    const created: Field = {
      id: this.newId(),
      name,
      version: 0,
      engineProps,
      entityId: entity.id,
      parentFieldId: null,
      ordinal,
      type,
      isNullable,
      isRestricted: false,
      isPii: false,
      isDeprecated: false,
      doc: null,
    };
    this.field[created.id] = created;
    this.fieldsByEntity.get(entity.id)?.set(normalizeName(name), created);
    return created;
  }

  updateField(field: Field, patch: Partial<Pick<Field, 'isNullable' | 'engineProps'>>): Field {
    const next: Field = { ...field, ...patch };
    this.field[field.id] = next;
    this.fieldsByEntity.get(field.entityId)?.set(normalizeName(field.name), next);
    return next;
  }

  findField(entity: Entity, name: string): Field | undefined {
    return this.fieldsByEntity.get(entity.id)?.get(normalizeName(name));
  }

  /** Every named column, or undefined when one is missing (reported, never invented). */
  findFields(entity: Entity, names: readonly string[]): readonly Field[] | undefined {
    const out: Field[] = [];
    for (const name of names) {
      const found = this.findField(entity, name);
      if (found === undefined) return undefined;
      out.push(found);
    }
    return out;
  }

  fieldsOf(entity: Entity): readonly Field[] {
    return [...(this.fieldsByEntity.get(entity.id)?.values() ?? [])];
  }

  constraintsOf(entity: Entity): readonly Constraint[] {
    return Object.values(this.constraint).filter((c) => c.entityId === entity.id);
  }

  addConstraint(
    entity: Entity,
    name: string,
    kind: string,
    fieldIds: readonly Id[],
    engineProps: EngineProps,
  ): Constraint {
    const created: Constraint = {
      id: this.newId(),
      name,
      version: 0,
      engineProps,
      entityId: entity.id,
      kind,
      fieldIds: [...fieldIds],
    };
    this.constraint[created.id] = created;
    return created;
  }

  addIndex(
    entity: Entity,
    name: string,
    kind: string,
    isUnique: boolean,
    columns: readonly IndexColumn[],
    engineProps: EngineProps,
  ): Index {
    const created: Index = {
      id: this.newId(),
      name,
      version: 0,
      engineProps,
      entityId: entity.id,
      kind,
      isUnique,
      columns: [...columns],
    };
    this.index[created.id] = created;
    return created;
  }

  hasIndexNamed(entity: Entity, name: string): boolean {
    const folded = normalizeName(name);
    return [...Object.values(this.index), ...Object.values(this.constraint)].some(
      (o) => o.entityId === entity.id && normalizeName(o.name) === folded,
    );
  }

  addLink(
    name: string,
    from: { entity: Entity; fieldIds: readonly Id[] },
    to: { entity: Entity; fieldIds: readonly Id[] },
    engineProps: EngineProps,
  ): Link {
    const created: Link = {
      id: this.newId(),
      name,
      version: 0,
      engineProps,
      kind: 'foreignKey',
      from: { entityId: from.entity.id, fieldIds: [...from.fieldIds] },
      to: { entityId: to.entity.id, fieldIds: [...to.fieldIds] },
      cardinality: 'N:1',
    };
    this.link[created.id] = created;
    return created;
  }

  linkCount(entity: Entity): number {
    return Object.values(this.link).filter((l) => l.from.entityId === entity.id).length;
  }

  toModel(projectId: Id, engineVersion: string): SchemaModel {
    return {
      irVersion: 1,
      projectId,
      engineId: 'mysql',
      engineVersion,
      redacted: false,
      objects: {
        area: {},
        namespace: this.namespace,
        customType: {},
        entity: this.entity,
        field: this.field,
        constraint: this.constraint,
        index: this.index,
        link: this.link,
      },
    };
  }
}
