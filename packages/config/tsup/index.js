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
  return defineConfig({
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    target: 'es2022',
    outDir: 'dist',
    ...overrides,
  });
}

export default libraryConfig;
