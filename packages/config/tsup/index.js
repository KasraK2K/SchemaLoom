import { defineConfig } from 'tsup';

/**
 * Shared tsup preset. Packages are COMPILED, not consumed as source (doc 01 §9.1),
 * so every package emits dual CJS+ESM plus declarations.
 *
 * `apps/api` compiles with module: Node16 and has no "type" field, so it resolves
 * the `require` condition — which is why cjs is not optional here.
 *
 * @param {import('tsup').Options} overrides
 */
export function libraryConfig(overrides = {}) {
  return defineConfig((options) => ({
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    // Never in watch mode. `turbo dev` runs `^build` first and then `tsup --watch`
    // alongside `nest start --watch`; a cleaning watcher deletes the `.d.ts` files the
    // build just wrote, nest compiles in that gap, fails on TS7016, and — watching only
    // `src/` — never retries. The API then simply never listens on 3001.
    clean: !options.watch,
    treeshake: true,
    target: 'es2022',
    outDir: 'dist',
    ...overrides,
  }));
}

export default libraryConfig;
