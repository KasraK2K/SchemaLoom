import { describe, expect, it } from 'vitest';
import * as f from '../fixtures.js';
import { SchemaModelSchema, type SchemaModel } from '../model.js';
import { validateModel } from '../validate.js';
import { RawSchemaModel } from './brand.js';
import { DEFAULT_NS, workflowModel } from './fixture.js';
import { redact } from './redact.js';
import { ctx } from './test-context.js';

/** The spec's workflow #2 viewer: Billing + HR tables, no payroll, no restricted fields. */
const viewer = (over: Parameters<typeof ctx>[0] = {}) =>
  ctx({
    visibleEntityIds: new Set(['en_1', 'en_2']),
    totalEntityCount: 3,
    entitiesWithRestrictedFields: new Set(['en_2']),
    ...over,
  });

const run = (model: SchemaModel, context = viewer()) =>
  redact(new RawSchemaModel(model), context);

describe('redact — the redacted model is a valid model', () => {
  it('parses against the same zod schema and carries redacted: true', () => {
    const out = run(workflowModel());
    expect(out.redacted).toBe(true);
    expect(() => SchemaModelSchema.parse(out)).not.toThrow();
  });

  // doc 04 §10.2 rule 4 — the rule revision 1 violated three ways over. A viewer whose
  // FK target column is restricted must not have the client log validation errors on
  // data that is working exactly as designed.
  it.each(['mask', 'hide'] as const)('validateModel reports no error in %s mode', (mode) => {
    const out = run(workflowModel(), viewer({ restrictedFieldMode: mode }));
    expect(validateModel(out).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('G3 — redaction is idempotent', () => {
    const once = run(workflowModel());
    const twice = redact(new RawSchemaModel(once), viewer());
    expect(twice).toEqual(once);
  });

  it('G3 — idempotent in hide mode too', () => {
    const context = viewer({ restrictedFieldMode: 'hide' });
    const once = run(workflowModel(), context);
    expect(redact(new RawSchemaModel(once), context)).toEqual(once);
  });

  it('a subject who cannot open the project gets an empty model, not a throw', () => {
    const out = run(workflowModel(), ctx({ canOpenProject: false }));
    expect(Object.values(out.objects).every((c) => Object.keys(c).length === 0)).toBe(true);
    expect(out.redacted).toBe(true);
  });
});

describe('L1 — link endpoint ids are real, the name is not', () => {
  it('keeps the real endpoint entity id and blanks every name on the way', () => {
    const out = run(workflowModel());
    const link = out.objects.link['lk_2'];
    expect(link?.from.entityId).toBe('en_3');
    expect(link?.name).toBe('');
    expect(out.objects.entity['en_3']?.name).toBe('');
  });
});

describe('L2 — link and FK names', () => {
  it('blanks name and engineProps on a link touching a stub', () => {
    const link = run(workflowModel()).objects.link['lk_2'];
    expect(link?.name).toBe('');
    expect(link?.engineProps).toEqual({});
    expect(link?.restricted).toBe(true);
  });

  it('clears BOTH sides of fieldIds together, never one (LINK_ARITY)', () => {
    const link = run(workflowModel()).objects.link['lk_2'];
    expect(link?.from.fieldIds).toEqual([]);
    expect(link?.to.fieldIds).toEqual([]);
  });

  it('leaves fieldIds alone when only a MASKED field is involved', () => {
    const model = f.model({
      namespace: f.byId([f.namespace(DEFAULT_NS, 'public', { isDefault: true })]),
      entity: f.byId([
        f.entity('ent_a', 'a', DEFAULT_NS),
        f.entity('ent_b', 'b', DEFAULT_NS),
      ]),
      field: f.byId([
        f.field('fld_a', 'a_id', 'ent_a'),
        f.field('fld_b', 'secret', 'ent_b', { isRestricted: true }),
      ]),
      link: f.byId([
        f.link('lnk', 'fk_a_b_secret', 'ent_a', 'ent_b', {
          from: { entityId: 'ent_a', fieldIds: ['fld_a'] },
          to: { entityId: 'ent_b', fieldIds: ['fld_b'] },
        }),
      ]),
    });
    const out = run(model, ctx({ visibleEntityIds: new Set(['ent_a', 'ent_b']) }));
    const link = out.objects.link['lnk'];
    expect(link?.from.fieldIds).toEqual(['fld_a']);
    expect(link?.to.fieldIds).toEqual(['fld_b']);
    expect(link?.name).toBe('');
    expect(validateModel(out).filter((i) => i.severity === 'error')).toEqual([]);
  });
});

describe('L3 — index definitions, including expression indexes', () => {
  it('drops an expression index whose body characterises a restricted column', () => {
    // `CREATE INDEX … ON employees ((salary * 12)) WHERE salary > 100000` references no
    // field id at all. Nothing but `refs` can catch it, and once the only key column is
    // an expression there is nothing left to badge.
    expect(run(workflowModel()).objects.index['ix_2']).toBeUndefined();
  });

  it('keeps an index over a masked field, blank (∆21), so the badge still renders', () => {
    const index = run(workflowModel()).objects.index['ix_1'];
    expect(index).toBeDefined();
    expect(index?.name).toBe('');
    expect(index?.engineProps).toEqual({});
    expect(index?.restricted).toBe(true);
    expect(index?.columns.map((c) => c.fieldId)).toEqual(['fd_5']);
  });

  it('drops an index outright when a column it names is HIDDEN', () => {
    const out = run(workflowModel(), viewer({ restrictedFieldMode: 'hide' }));
    expect(out.objects.index['ix_1']).toBeUndefined();
  });
});

describe('L4 — constraint expressions', () => {
  it('drops the CHECK body and the constraint name, keeps the badge', () => {
    const constraint = run(workflowModel()).objects.constraint['cs_2'];
    expect(constraint?.name).toBe('');
    expect(constraint?.engineProps).toEqual({});
    expect(constraint?.fieldIds).toEqual(['fd_5']);
    expect(constraint?.restricted).toBe(true);
  });

  it('leaves a primary key over visible columns entirely alone', () => {
    const constraint = run(workflowModel()).objects.constraint['cs_1'];
    expect(constraint?.name).toBe('employees_pkey');
    expect(constraint?.restricted).toBeUndefined();
  });
});

describe('L5 / L6 — defaults and generated columns (R27)', () => {
  it('blanks the props of a VISIBLE field whose expression names a restricted column', () => {
    const field = run(workflowModel()).objects.field['fd_6'];
    expect(field?.name).toBe('bonus');
    expect(field?.engineProps).toEqual({});
    expect(field?.propsRedacted).toBe(true);
  });

  it('never ships the expression string itself', () => {
    expect(JSON.stringify(run(workflowModel()))).not.toContain('salary * 0.1');
  });
});

describe('R27 fails closed', () => {
  it('drops the props of an object whose engine declared NO refs', () => {
    // `ent_emp.engineProps.tablespace` and the link's `onDelete` carry no `refs`. An
    // engine that forgets to populate them must not thereby ship them verbatim.
    const out = run(workflowModel());
    expect(out.objects.entity['en_2']?.engineProps).toEqual({});
    expect(out.objects.link['lk_1']?.engineProps).toEqual({});
    expect(out.objects.link['lk_1']?.propsRedacted).toBe(true);
  });

  it('drops the props of an object whose engine returned EMPTY refs', () => {
    const model = workflowModel();
    const entity = model.objects.entity['en_2'];
    if (entity === undefined) throw new Error('fixture');
    model.objects.entity['en_2'] = { ...entity, refs: { entityIds: [], fieldIds: [] } };
    expect(run(model).objects.entity['en_2']?.engineProps).toEqual({});
  });

  it('keeps props when the engine declared refs and every one of them is visible', () => {
    const model = workflowModel();
    const entity = model.objects.entity['en_1'];
    if (entity === undefined) throw new Error('fixture');
    model.objects.entity['en_1'] = {
      ...entity,
      engineProps: { fillfactor: 70 },
      refs: { entityIds: ['en_2'], fieldIds: ['fd_3'] },
    };
    expect(run(model).objects.entity['en_1']?.engineProps).toEqual({ fillfactor: 70 });
  });

  it('is a no-op for a viewer with nothing hidden — props survive without refs', () => {
    const out = run(
      workflowModel(),
      ctx({
        visibleEntityIds: new Set(['en_1', 'en_2', 'en_3']),
        restrictedOkEntityIds: new Set(['en_1', 'en_2', 'en_3']),
        totalEntityCount: 3,
      }),
    );
    expect(out.objects.entity['en_2']?.engineProps).toEqual({ tablespace: 'hr_fast' });
    expect(out.objects.entity['en_2']?.propsRedacted).toBeUndefined();
  });
});

describe('L22 / ∆15 — ordinal gaps', () => {
  it('renumbers siblings densely in hide mode; no gap survives', () => {
    const out = run(workflowModel(), viewer({ restrictedFieldMode: 'hide' }));
    const emp = Object.values(out.objects.field).filter((x) => x.entityId === 'en_2');
    expect(emp.map((x) => x.id).sort()).toEqual(['fd_3', 'fd_4', 'fd_6']);
    expect(emp.map((x) => x.ordinal).sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it('renumbers per (entityId, parentFieldId), never per entity', () => {
    const model = f.model({
      namespace: f.byId([f.namespace(DEFAULT_NS, 'public', { isDefault: true })]),
      entity: f.byId([f.entity('ent_a', 'a', DEFAULT_NS)]),
      field: f.byId([
        f.field('fld_doc', 'doc', 'ent_a'),
        f.field('fld_c0', 'c0', 'ent_a', { parentFieldId: 'fld_doc', ordinal: 0 }),
        f.field('fld_c1', 'c1', 'ent_a', {
          parentFieldId: 'fld_doc',
          ordinal: 1,
          isRestricted: true,
        }),
        f.field('fld_c2', 'c2', 'ent_a', { parentFieldId: 'fld_doc', ordinal: 2 }),
      ]),
    });
    const out = run(
      model,
      ctx({ visibleEntityIds: new Set(['ent_a']), restrictedFieldMode: 'hide' }),
    );
    expect(out.objects.field['fld_doc']?.ordinal).toBe(0);
    expect(out.objects.field['fld_c0']?.ordinal).toBe(0);
    expect(out.objects.field['fld_c2']?.ordinal).toBe(1);
    expect(validateModel(out).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('R24 — a hidden parent takes its children with it', () => {
    const model = f.model({
      namespace: f.byId([f.namespace(DEFAULT_NS, 'public', { isDefault: true })]),
      entity: f.byId([f.entity('ent_a', 'a', DEFAULT_NS)]),
      field: f.byId([
        f.field('fld_p', 'payload', 'ent_a', { isRestricted: true }),
        f.field('fld_c', 'ssn', 'ent_a', { parentFieldId: 'fld_p', ordinal: 0 }),
      ]),
    });
    const out = run(
      model,
      ctx({ visibleEntityIds: new Set(['ent_a']), restrictedFieldMode: 'hide' }),
    );
    expect(out.objects.field).toEqual({});
  });
});

describe('∆4 — a masked field discloses no name and no type', () => {
  it('keeps only id, entityId, parentFieldId and ordinal', () => {
    const field = run(workflowModel()).objects.field['fd_5'];
    expect(field).toEqual({
      id: 'fd_5',
      name: '',
      version: 0,
      engineProps: {},
      restricted: true,
      entityId: 'en_2',
      parentFieldId: null,
      ordinal: 2,
      type: { name: '' },
      isNullable: true,
      isRestricted: true,
      isPii: false,
      isDeprecated: false,
      doc: null,
    });
  });

  it('never ships the name or the type anywhere in the payload', () => {
    const json = JSON.stringify(run(workflowModel()));
    expect(json).not.toContain('salary');
    expect(json).not.toContain('numeric');
  });
});

describe('R-2 — stubs, namespaces and the default namespace', () => {
  it('a stub carries the real id and kind but the DEFAULT namespaceId', () => {
    const stub = run(workflowModel()).objects.entity['en_3'];
    expect(stub).toEqual({
      id: 'en_3',
      name: '',
      version: 0,
      engineProps: {},
      restricted: true,
      namespaceId: DEFAULT_NS,
      kind: 'materializedView',
      areaId: null,
      position: { x: 1240, y: 380 },
      color: null,
      doc: null,
    });
  });

  it('a namespace holding only restricted entities does not appear', () => {
    const out = run(workflowModel());
    expect(out.objects.namespace['ns_2']).toBeUndefined();
    expect(out.objects.namespace[DEFAULT_NS]).toBeDefined();
    expect(JSON.stringify(out)).not.toContain('payroll_private');
  });

  it('an invisible entity nothing surviving points at is absent, not stubbed', () => {
    const model = workflowModel();
    delete model.objects.link['lk_2'];
    const out = run(model);
    expect(out.objects.entity['en_3']).toBeUndefined();
  });
});

describe('§8.3 — areas', () => {
  it('keeps an area holding a visible entity and drops an empty one', () => {
    const out = run(workflowModel());
    expect(Object.keys(out.objects.area).sort()).toEqual(['ar_1', 'ar_2']);
  });

  it('keeps an empty area the subject holds an atom on (SPEC workflow #2)', () => {
    const out = run(workflowModel(), viewer({ areasWithAtoms: new Set(['ar_3']) }));
    expect(out.objects.area['ar_3']).toBeDefined();
  });

  it('a stub never keeps an area alive and never carries an areaId', () => {
    const out = run(workflowModel(), ctx({ visibleEntityIds: new Set(['en_2']) }));
    expect(out.objects.entity['en_3']?.areaId).toBeNull();
    expect(Object.keys(out.objects.area)).toEqual(['ar_2']);
  });
});

describe('R-1 — restricted and propsRedacted are independent', () => {
  it('a FULLY VISIBLE field carries propsRedacted and is not restricted', () => {
    const field = run(workflowModel()).objects.field['fd_6'];
    expect(field?.propsRedacted).toBe(true);
    expect(field?.restricted).toBeUndefined();
    // The exporter's rule is `skip if restricted && type === 'entity'`, `keep if
    // propsRedacted`. Any `if (obj.restricted)` path must leave this object alone.
    expect(Object.values(run(workflowModel()).objects.field).filter((x) => x.restricted === true))
      .toHaveLength(1);
  });

  it('an entity whose badges were degraded is marked propsRedacted, never restricted', () => {
    // doc 04 §10.2's closing rule, spelled per R-1: marking a VISIBLE entity `restricted`
    // would make the exporter skip a table the viewer can see.
    const entity = run(workflowModel()).objects.entity['en_2'];
    expect(entity?.propsRedacted).toBe(true);
    expect(entity?.restricted).toBeUndefined();
    expect(entity?.name).toBe('employees');
  });

  it('leaves an untouched visible entity with neither flag', () => {
    const entity = run(workflowModel()).objects.entity['en_1'];
    expect(entity?.restricted).toBeUndefined();
    expect(entity?.propsRedacted).toBeUndefined();
  });
});

describe('§7.10 — field:viewRestricted is per entity', () => {
  it('unmasks the restricted column only on the entity the atom was granted on', () => {
    const out = run(workflowModel(), viewer({ restrictedOkEntityIds: new Set(['en_2']) }));
    expect(out.objects.field['fd_5']?.name).toBe('salary');
    expect(out.objects.index['ix_1']?.name).toBe('idx_employees_salary');
  });
});
