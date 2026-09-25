import { unitConfig } from '@schemaloom/config/vitest';

// tsconfig says `jsx: preserve` because Next does the JSX transform in the app build.
// esbuild honours that, so without this override vitest would hand raw JSX to node.
export default unitConfig({ esbuild: { jsx: 'automatic' } });
