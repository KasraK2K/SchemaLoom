import { libraryConfig } from '@schemaloom/config/tsup';

/**
 * Two entries, deliberately. `./static` is the browser-safe facet (types, terminology,
 * link rules) that apps/web imports; `.` is the server half that pulls in libpg-query.
 * `splitting: true` keeps the shared chunk out of both bundles twice, and the dynamic
 * import() of libpg-query must stay dynamic so `./static` never drags a native module
 * into the browser build.
 */
export default libraryConfig({
  entry: ['src/index.ts', 'src/static.ts'],
  splitting: true,
});
