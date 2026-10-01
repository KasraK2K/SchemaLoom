import { defineConfig } from 'tsup';

/** A bin, not a library: one ESM file with a shebang, no declarations, no dependencies. */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
});
