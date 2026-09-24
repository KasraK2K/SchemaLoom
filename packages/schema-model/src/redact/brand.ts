import type { SchemaModel } from '../model.js';

/**
 * Doc 05 §8.6 / doc 04 §10.2 — THE SINGLE-PATH RULE, part 1: the box and the brand.
 *
 * Nothing in this file is re-exported from the package index except `RawSchemaModel`
 * and the `RedactedModel` type. `unwrapRaw` and `brandRedacted` stay package-private,
 * which is what makes "`VisibilityFilter` is the only way schema data leaves the server"
 * structural instead of a convention people remember.
 */

declare const REDACTED: unique symbol;

/**
 * Structurally a `SchemaModel` — same type, same zod schema — plus a PHANTOM brand no
 * cast-free code can forge. Deliberately not `SchemaModel & { redacted: true }`: that is
 * a structural narrowing `{ ...model, redacted: true }` satisfies, so any code could mint
 * one without a cast and the "the compiler says it" claim would be false. The RUNTIME
 * marker is the ordinary `redacted: true` field the model already carries.
 *
 * Every serializer — exporter, AI context, snapshot writer, the IR DTO mapper — takes
 * this type, so a raw model cannot reach one by accident.
 */
export type RedactedModel = SchemaModel & { readonly [REDACTED]: true };

/**
 * Where the payload lives. NOT a field on the instance.
 *
 * Doc 05 §8.6 specifies `readonly #model` plus a symbol-keyed static unwrap. A
 * module-level `WeakMap` reaches the same goal and is strictly stronger: the payload is
 * not a property of the instance at all, so `Object.entries`, `structuredClone`, a
 * debugger and a `{ ...raw }` spread all come up empty, and the only key is this
 * binding, which no consumer can import (the package `exports` map has one entry).
 */
const BOX = new WeakMap<RawSchemaModel, SchemaModel>();

/**
 * The only thing a schema loader returns. The payload is genuinely unreachable: there is
 * no `.ir`, no getter and no exported unwrap, so `return raw.ir` does not compile and
 * `JSON.stringify(raw)` throws instead of leaking.
 *
 * The earlier `readonly ir: SchemaModel` public field enforced nothing — the realistic
 * mistake is `const { ir } = await loader.load(id); return ir;`, and that value is a
 * plain `SchemaModel` that sails past any `instanceof` check.
 */
export class RawSchemaModel {
  constructor(model: SchemaModel) {
    BOX.set(this, model);
  }

  /** Any accidental serialization fails loudly instead of leaking. */
  toJSON(): never {
    throw new Error('raw_ir_escaped');
  }
}

/**
 * Package-private. `redact` is the only caller, and the package index does not export
 * this. Fails closed on anything that is not a real box (a prototype forgery, a
 * structuredClone).
 */
export function unwrapRaw(raw: RawSchemaModel): SchemaModel {
  const model = BOX.get(raw);
  if (model === undefined) throw new Error('raw_ir_escaped');
  return model;
}

/** The one cast in the codebase. Package-private: `redact` is its only caller. */
export function brandRedacted(model: SchemaModel): RedactedModel {
  return model as RedactedModel;
}
