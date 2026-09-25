import { fileURLToPath } from 'node:url';
import { unitConfig } from '@schemaloom/config/vitest';

const src = fileURLToPath(new URL('./src', import.meta.url));

export default unitConfig({
  // Vite does not read tsconfig `paths`, so `@/` is re-declared here. And esbuild
  // honours `jsx: preserve` from the tsconfig, which would hand raw JSX to node.
  resolve: { alias: [{ find: /^@\//, replacement: `${src}/` }] },
  esbuild: { jsx: 'automatic' },
});
