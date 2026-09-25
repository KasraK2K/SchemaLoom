import { libraryConfig } from '@schemaloom/config/tsup';

/**
 * Two entries, and the second one is not a convenience.
 *
 * §17's conformance suite calls vitest's `describe`/`it`. Put it on the "." barrel and
 * `dist/index.cjs` gains a `require('vitest')` — which `apps/api`, a CommonJS package, hits on
 * the very first import of the SDK and dies on ("Vitest cannot be imported in a CommonJS
 * module using require()"). `apps/web` would ship the test runner in its browser bundle for
 * the same reason. So the suite gets its own entry and its own `exports` condition, which is
 * where §17 puts it anyway.
 *
 * `vitest` is external rather than bundled: tsup externalises `dependencies` and
 * `peerDependencies` only, and vitest is a devDependency. Every consumer of this entry is a
 * test file, which already has it.
 */
export default libraryConfig({
  // `src/ui/index.ts` is the third entry for the mirror-image reason (§16): it is the
  // browser's surface, and the react preset forbids browser code from importing the "."
  // barrel. Giving it its own chunk is also what lets the barrel grow a server half without
  // dragging it into the canvas bundle.
  entry: ['src/index.ts', 'src/ui/index.ts', 'src/conformance/index.ts'],
  external: ['vitest'],
});
