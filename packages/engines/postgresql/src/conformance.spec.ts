import { runEngineConformance } from '@schemaloom/engine-sdk/conformance';
import { CONFORMANCE_FIXTURES } from './conformance-fixtures.js';
import { postgresEngine } from './index.js';

/**
 * Doc 03 §17 — the whole file. An engine that does not pass this is not registered.
 *
 * `./index.js`, not `@schemaloom/engine-postgresql`: the shared eslint config bans importing
 * an engine by package name (C10), and inside the engine's own package the relative path is
 * the same object anyway.
 */
runEngineConformance(postgresEngine, CONFORMANCE_FIXTURES);
