import type { EngineDefinition } from '@schemaloom/engine-sdk';
import { mysqlEngine } from '@schemaloom/engine-mysql';
import { postgresEngine } from '@schemaloom/engine-postgresql';

/**
 * Doc 01 §4.2 — **the ONLY file in `apps/api` that names a concrete engine.**
 *
 * Adding an engine is `pnpm add @schemaloom/engine-<x>` plus one line here. No file under
 * `access/`, `schema/`, `projects/`, `transfer/` or `engines/engines.module.ts` changes, and
 * nothing else in core ever imports an engine package — everything resolves through
 * `EngineRegistry` by `project.engineId`.
 *
 * The shared eslint config bans `@schemaloom/engine-*` imports everywhere via
 * `no-restricted-imports`, which is how C10 stops core code reaching past the registry.
 * This file is the ONE sanctioned exception, granted by a single-file override in
 * `apps/api/eslint.config.js` rather than an inline disable — an override names the
 * exception in one visible place, where an inline comment invites the next person to
 * copy it into a second file. Do not widen the rule.
 */
// PostgreSQL first: specs that need "a real engine" take `ENGINE_MANIFEST[0]`.
export const ENGINE_MANIFEST: readonly EngineDefinition[] = [postgresEngine, mysqlEngine];
