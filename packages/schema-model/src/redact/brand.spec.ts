import { describe, expect, it } from 'vitest';
import { RawSchemaModel, unwrapRaw } from './brand.js';
import { workflowModel } from './fixture.js';
import { redact } from './redact.js';
import { ctx } from './test-context.js';

/**
 * §8.6 — the single-path rule. The mechanism an earlier draft proposed (`readonly ir:
 * SchemaModel`, a PUBLIC field) enforced nothing: the realistic mistake is
 * `const { ir } = await loader.load(id); return ir;`, and that value is a plain
 * `SchemaModel` with no class identity that sails past any `instanceof` check.
 */
describe('RawSchemaModel — the payload is genuinely unreachable', () => {
  it('has no own properties to read, spread or clone', () => {
    const raw = new RawSchemaModel(workflowModel());
    expect(Object.keys(raw)).toEqual([]);
    expect(Object.getOwnPropertyNames(raw)).toEqual([]);
    // The rule is right in general and wrong here: spreading a class instance IS
    // the assertion. If this ever yields keys, the payload stopped being private.
    // eslint-disable-next-line @typescript-eslint/no-misused-spread
    expect({ ...raw }).toEqual({});
  });

  it('throws instead of leaking when something serialises it by accident', () => {
    const raw = new RawSchemaModel(workflowModel());
    expect(() => JSON.stringify(raw)).toThrow('raw_ir_escaped');
    expect(() => JSON.stringify({ data: raw })).toThrow('raw_ir_escaped');
    expect(() => JSON.stringify([raw])).toThrow('raw_ir_escaped');
  });

  it('fails closed on a forged instance rather than returning a stale model', () => {
    const forged = Object.create(RawSchemaModel.prototype) as RawSchemaModel;
    expect(() => unwrapRaw(forged)).toThrow('raw_ir_escaped');
  });

  it('hands the model to redact and nowhere else', () => {
    const model = workflowModel();
    const out = redact(new RawSchemaModel(model), ctx({ visibleEntityIds: new Set(['en_1']) }));
    expect(out.redacted).toBe(true);
    expect(model.redacted).toBe(false); // G2: the input is never mutated
  });
});
