import { describe, expect, it } from 'vitest';
import type { SchemaModel } from '../model.js';
import { RawSchemaModel } from './brand.js';
import type { VisibilityContext } from './context.js';
import { workflowModel } from './fixture.js';
import { redactPatch, type ModelPatch } from './patch.js';
import { redact } from './redact.js';
import { ctx } from './test-context.js';

/** Billing + HR visible, payroll (`en_3`) not, no `field:viewRestricted`. */
const viewer = (over: Partial<VisibilityContext> = {}) =>
  ctx({
    visibleEntityIds: new Set(['en_1', 'en_2']),
    totalEntityCount: 3,
    entitiesWithRestrictedFields: new Set(['en_2']),
    ...over,
  });

const view = (model: SchemaModel, context: VisibilityContext) =>
  redact(new RawSchemaModel(model), context);

const edit = (fn: (m: SchemaModel) => void): SchemaModel => {
  const m = structuredClone(workflowModel());
  fn(m);
  return m;
};

const NO_OP: ModelPatch = { changed: {}, removed: [] };

describe('redactPatch — the visibility transition (doc 04 §8.7)', () => {
  it('visible → visible: the redacted post-image', () => {
    const after = edit((m) => {
      m.objects.entity.en_1!.name = 'bills';
      m.objects.entity.en_1!.version += 1;
    });
    const out = redactPatch(NO_OP, view(workflowModel(), viewer()), view(after, viewer()));
    expect(out?.changed.entity?.en_1?.name).toBe('bills');
    expect(out?.removed).toEqual([]);
  });

  it('visible → masked: the MASKED post-image, never omitted', () => {
    const after = edit((m) => {
      m.objects.field.fd_4!.isRestricted = true;
    });
    const out = redactPatch(NO_OP, view(workflowModel(), viewer()), view(after, viewer()));
    const field = out?.changed.field?.fd_4;
    expect(field).toBeDefined();
    expect(field?.name).toBe('');
    expect(JSON.stringify(out)).not.toContain('full_name');
  });

  it('visible → hidden: a synthetic removed entry', () => {
    const after = edit((m) => {
      m.objects.field.fd_4!.isRestricted = true;
    });
    const hide = viewer({ restrictedFieldMode: 'hide' });
    const out = redactPatch(NO_OP, view(workflowModel(), hide), view(after, hide));
    expect(out?.removed).toContainEqual({ type: 'field', id: 'fd_4' });
    expect(out?.changed.field?.fd_4).toBeUndefined();
  });

  it('hidden → visible: the full post-image', () => {
    const before = view(workflowModel(), viewer());
    const after = view(workflowModel(), viewer({ visibleEntityIds: new Set(['en_1', 'en_2', 'en_3']) }));
    const out = redactPatch(NO_OP, before, after);
    expect(out?.changed.field?.fd_7?.name).toBe('id');
    expect(out?.changed.entity?.en_3?.name).toBe('payroll_runs');
  });

  it('invisible → invisible: nothing, so null and the caller does not emit', () => {
    const after = edit((m) => {
      m.objects.field.fd_7!.name = 'run_id';
      m.objects.field.fd_7!.version += 1;
    });
    expect(redactPatch(NO_OP, view(workflowModel(), viewer()), view(after, viewer()))).toBeNull();
  });

  it('removed is never filtered, even for an object the recipient never saw', () => {
    const after = edit((m) => {
      delete m.objects.field.fd_7;
    });
    const patch = { ...NO_OP, seq: 7, removed: [{ type: 'field' as const, id: 'fd_7' }] };
    const out = redactPatch(patch, view(workflowModel(), viewer()), view(after, viewer()));
    expect(out?.removed).toEqual([{ type: 'field', id: 'fd_7' }]);
    expect(out?.seq).toBe(7);
  });

  it('never reads the patch’s raw post-images', () => {
    const patch: ModelPatch = {
      changed: { field: { fd_5: { ...workflowModel().objects.field.fd_5!, name: 'salary' } } },
      removed: [],
    };
    const before = view(workflowModel(), viewer());
    expect(redactPatch(patch, before, view(workflowModel(), viewer()))).toBeNull();
  });
});
