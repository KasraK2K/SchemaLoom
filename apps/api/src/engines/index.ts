/**
 * The engines module's public surface. `ENGINE_MANIFEST` is deliberately NOT here: it is the
 * one file that names concrete engines and nothing outside this folder reads it.
 */
export { EnginesModule } from './engines.module';
export { EnginesController } from './engines.controller';
export { ENGINE_REGISTRY } from './engines.tokens';
export { COMING_SOON } from './coming-soon.const';
export {
  EngineGate,
  ProjectReadOnlyException,
  assertWritable,
  type EngineReadOnlyReason,
  type ProjectEngineRef,
  type ProjectEngineState,
  type ReadOnlyEngineState,
  type WritableEngineState,
} from './engine-gate.service';
