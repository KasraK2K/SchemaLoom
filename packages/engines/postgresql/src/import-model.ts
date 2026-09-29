import type {
  Constraint,
  CustomType,
  EngineProps,
  Entity,
  Field,
  Id,
  Index,
  IndexColumn,
  IrObjectRef,
  Link,
  Namespace,
  SchemaModel,
  TypeRef,
  TypeResolutionContext,
} from '@schemaloom/engine-sdk';
import type { ParsedTypeName as ParsedTypeSpelling } from './import-ast.js';
import { normalizeName } from './normalize-name.js';
import { TYPE_CATALOG } from './types.js';

/**
 * The IR under construction during an import, plus the symbol table that resolves one
 * statement's names against another statement's objects.
 *
 * WHY A SYMBOL TABLE AND NOT A POST-PASS OVER NAMES: `ALTER TABLE orders ADD CONSTRAINT …
 * REFERENCES customers(id)` has to become a `Link` between two ids, and `customers` may be
 * defined ten statements later. The importer therefore runs two passes over the same
 * statement list — declarations first, then everything that references one — and this object
 * is what the second pass reads. Ids are minted in source order in both passes, which is what
 * makes `import/deterministic` hold under a seeded `newId`.
 *
 * Lookup keys go through `normalizeName`: PostgreSQL folds unquoted identifiers, so
 * `REFERENCES Customers` and `CREATE TABLE customers` are the same table. Stored `name`
 * values are whatever the parser produced — it has already folded what it should.
 */
export class ImportModel {
  readonly namespace: Record<Id, Namespace> = {};
  readonly customType: Record<Id, CustomType> = {};
  readonly entity: Record<Id, Entity> = {};
  readonly field: Record<Id, Field> = {};
  readonly constraint: Record<Id, Constraint> = {};
  readonly index: Record<Id, Index> = {};
  readonly link: Record<Id, Link> = {};

  private readonly namespaceByName = new Map<string, Namespace>();
  private readonly entityByKey = new Map<string, Entity>();
  private readonly fieldsByEntity = new Map<Id, Map<string, Field>>();
  private readonly ordinals = new Map<Id, number>();

  constructor(
    private readonly newId: () => Id,
    readonly defaultNamespaceName: string,
  ) {
    this.ensureNamespace(defaultNamespaceName, true);
  }

  // --- namespaces -----------------------------------------------------------------------

  ensureNamespace(name: string, isDefault = false): Namespace {
    const key = normalizeName(name);
    const existing = this.namespaceByName.get(key);
    if (existing !== undefined) return existing;
    const created: Namespace = {
      id: this.newId(),
      name,
      version: 0,
      engineProps: {},
      isDefault,
    };
    this.namespace[created.id] = created;
    this.namespaceByName.set(key, created);
    return created;
  }

  /** The namespace a statement's object belongs to: the one it qualified itself with, or the
   *  project default. */
  resolveNamespace(schema: string | undefined): Namespace {
    return this.ensureNamespace(schema ?? this.defaultNamespaceName);
  }

  // --- custom types ---------------------------------------------------------------------

  addCustomType(
    schema: string | undefined,
    name: string,
    kind: string,
    engineProps: EngineProps,
  ): CustomType {
    const namespace = this.resolveNamespace(schema);
    const created: CustomType = {
      id: this.newId(),
      name,
      version: 0,
      engineProps,
      namespaceId: namespace.id,
      kind,
    };
    this.customType[created.id] = created;
    return created;
  }

  // --- entities and fields ----------------------------------------------------------------

  private entityKey(namespaceName: string, name: string): string {
    return `${normalizeName(namespaceName)}.${normalizeName(name)}`;
  }

  addEntity(
    schema: string | undefined,
    name: string,
    kind: string,
    engineProps: EngineProps,
  ): Entity {
    const namespace = this.resolveNamespace(schema);
    const created: Entity = {
      id: this.newId(),
      name,
      version: 0,
      engineProps,
      namespaceId: namespace.id,
      kind,
      areaId: null,
      // The canvas lays an imported model out itself; the IR needs a value, not a guess.
      position: { x: 0, y: 0 },
      color: null,
      doc: null,
    };
    this.entity[created.id] = created;
    this.entityByKey.set(this.entityKey(namespace.name, name), created);
    this.fieldsByEntity.set(created.id, new Map());
    this.ordinals.set(created.id, 0);
    return created;
  }

  /** Exact (namespace, folded name) match — unlike `findEntity`, no cross-namespace guess. */
  hasEntity(schema: string | undefined, name: string): boolean {
    return this.entityByKey.has(this.entityKey(schema ?? this.defaultNamespaceName, name));
  }

  findEntity(schema: string | undefined, name: string): Entity | undefined {
    const direct = this.entityByKey.get(this.entityKey(schema ?? this.defaultNamespaceName, name));
    if (direct !== undefined || schema !== undefined) return direct;
    // An unqualified reference in a script that qualified the definition: PostgreSQL would
    // resolve it through `search_path`, which an imported file does not carry. One unique
    // match across namespaces is the only unambiguous answer, so it is the only one taken.
    const folded = normalizeName(name);
    const matches = Object.values(this.entity).filter((e) => normalizeName(e.name) === folded);
    return matches.length === 1 ? matches[0] : undefined;
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

  findField(entity: Entity, name: string): Field | undefined {
    return this.fieldsByEntity.get(entity.id)?.get(normalizeName(name));
  }

  /** Every named column, or undefined when one of them is not in this import — which the
   *  caller reports as a loss rather than creating a constraint over a phantom column. */
  findFields(entity: Entity, names: readonly string[]): readonly Field[] | undefined {
    const out: Field[] = [];
    for (const name of names) {
      const found = this.findField(entity, name);
      if (found === undefined) return undefined;
      out.push(found);
    }
    return out;
  }

  // --- dependent objects ------------------------------------------------------------------

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

  // --- output -----------------------------------------------------------------------------

  typeContext(namespaceId: Id): TypeResolutionContext {
    return {
      customTypes: Object.values(this.customType),
      namespaceName: this.namespace[namespaceId]?.name ?? this.defaultNamespaceName,
    };
  }

  buildTypeRef(
    namespaceId: Id,
    spelling: string,
    args: readonly (string | number)[],
    dimensions: number,
  ): TypeRef {
    return TYPE_CATALOG.buildRef(
      {
        name: spelling,
        ...(args.length > 0 ? { args } : {}),
        ...(dimensions > 0 ? { dimensions } : {}),
      },
      this.typeContext(namespaceId),
    );
  }

  /**
   * The canonical DDL spelling of a type — `pg_catalog.int4` -> `integer`.
   *
   * A `Field.type` is a structured `TypeRef` and canonical by construction, but a domain's
   * `baseType` and a composite attribute's `type` are STRINGS in `engineProps`, and the raw
   * parse tree spells them with PostgreSQL's internal names. Storing `int4` there means the
   * exporter writes `CREATE DOMAIN … AS int4`: valid, but not what the user typed and not
   * what the same type looks like anywhere else in the model.
   */
  typeSpelling(namespaceId: Id, parsed: ParsedTypeSpelling): string {
    const ref = this.buildTypeRef(namespaceId, parsed.name, parsed.args, parsed.dimensions);
    return TYPE_CATALOG.format(TYPE_CATALOG.resolve(ref, this.typeContext(namespaceId)));
  }

  toModel(projectId: Id, engineVersion: string): SchemaModel {
    return {
      irVersion: 1,
      projectId,
      engineId: 'postgresql',
      engineVersion,
      redacted: false,
      objects: {
        area: {},
        namespace: this.namespace,
        customType: this.customType,
        entity: this.entity,
        field: this.field,
        constraint: this.constraint,
        index: this.index,
        link: this.link,
      },
    };
  }
}

export function ref(type: IrObjectRef['type'], id: Id): IrObjectRef {
  return { type, id };
}
