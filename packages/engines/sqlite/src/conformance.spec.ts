import { runEngineConformance } from '@schemaloom/engine-sdk/conformance';
import { CONFORMANCE_FIXTURES } from './conformance-fixtures.js';
import { sqliteEngine } from './index.js';

/** Doc 03 §17 — an engine that does not pass this is not registered. */
runEngineConformance(sqliteEngine, CONFORMANCE_FIXTURES);
