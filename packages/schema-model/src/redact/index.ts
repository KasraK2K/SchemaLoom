/**
 * The package's redaction surface. `unwrapRaw` and `brandRedacted` are DELIBERATELY not
 * here: doc 05 §8.6's single-path rule rests on the payload having no exported accessor
 * and `RedactedModel` having no exported constructor other than `redact`.
 */
export { RawSchemaModel, type RedactedModel } from './brand.js';
export {
  fieldVisibility,
  fieldVisibilityIndex,
  type FieldVisibility,
  type FieldVisibilityIndex,
  type RestrictedFieldMode,
  type VisibilityContext,
} from './context.js';
export { redact } from './redact.js';
export { redactPatch, type ModelPatch } from './patch.js';
