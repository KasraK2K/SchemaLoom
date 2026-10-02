import { libraryConfig } from '@schemaloom/config/tsup';

/**
 * Two entries, as in the PostgreSQL engine: `./static` is the browser-safe facet apps/web
 * imports, `.` the server half that loads node-sql-parser. The parser is loaded with a
 * dynamic import() so `./static` never pulls it into a browser chunk.
 */
export default libraryConfig({
  entry: ['src/index.ts', 'src/static.ts'],
  splitting: true,
});
