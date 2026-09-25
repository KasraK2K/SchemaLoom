import { defineConfig } from 'vitest/config';

/**
 * Shared vitest presets.
 *
 * NOTE ON THE MERGE, because an earlier version of this file got it wrong and the
 * failure was silent: `overrides` must have its `test` key pulled OUT before the rest
 * is spread. Writing
 *
 *     defineConfig({ test: { ...defaults, ...overrides.test }, ...overrides })
 *
 * looks right and is not — the trailing `...overrides` re-assigns `test` wholesale,
 * discarding every default that the line above just merged. A caller passing
 * `{ test: { environment: 'node' } }` then silently loses `include`, `exclude` AND
 * `passWithNoTests`, so vitest falls back to its own defaults, finds no files, and
 * exits 1 on a package that is simply not tested yet. Destructure instead.
 */

const UNIT_DEFAULTS = {
  include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
  exclude: ['**/node_modules/**', '**/dist/**', '**/*.int.spec.ts'],
  environment: 'node',
  clearMocks: true,
  // A package mid-build-out legitimately has no tests yet (a lone constant needs
  // none). Without this, `turbo test` fails the whole graph on an empty package and
  // someone "fixes" it by deleting the task.
  passWithNoTests: true,
  coverage: { provider: 'v8', reporter: ['text', 'lcov'], reportsDirectory: 'coverage' },
};

const INTEGRATION_DEFAULTS = {
  include: ['src/**/*.int.spec.ts', 'test/**/*.int.spec.ts'],
  environment: 'node',
  clearMocks: true,
  fileParallelism: false,
  passWithNoTests: true,
  hookTimeout: 60_000,
  testTimeout: 30_000,
  retry: 0,
};

/**
 * Unit-test preset. `turbo test` must stay cacheable and must run on a machine with no
 * Docker, so this EXCLUDES *.int.spec.ts — integration tests run under the separate,
 * uncached `test:int` task (doc 01 §8.2).
 *
 * @param {import('vitest/config').UserConfig} overrides
 */
export function unitConfig(overrides = {}) {
  const { test: testOverrides, ...rest } = overrides;
  return defineConfig({ ...rest, test: { ...UNIT_DEFAULTS, ...testOverrides } });
}

/**
 * Integration-test preset: real Postgres + Redis, never cached, serial. Serial at ~30
 * tests is fine and a coffee break at 300 — the upgrade path is schema-per-worker
 * (doc 01 §12.1). Nobody is to "fix" the slowness with retries.
 *
 * @param {import('vitest/config').UserConfig} overrides
 */
export function integrationConfig(overrides = {}) {
  const { test: testOverrides, ...rest } = overrides;
  return defineConfig({ ...rest, test: { ...INTEGRATION_DEFAULTS, ...testOverrides } });
}

export default unitConfig;
