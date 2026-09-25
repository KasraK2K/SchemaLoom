/**
 * The injection token for the one `EngineRegistry` (doc 01 §4.2).
 *
 * In its own file, not in `engines.module.ts` as the doc's snippet draws it, because the
 * module imports the controller and the controller injects the token: a token declared in
 * the module file makes that a require cycle, which under CommonJS resolves to `undefined`
 * at decoration time and fails DI with an unhelpful "Nest can't resolve dependencies".
 */
export const ENGINE_REGISTRY = Symbol('ENGINE_REGISTRY');
