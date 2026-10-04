import { libraryConfig } from '@schemaloom/config/tsup';

/**
 * Two entries, as in the other engines: `./static` is the browser-safe facet apps/web
 * imports, `.` the server half that runs `node:sqlite` and node-sql-parser. Both load lazily,
 * so `./static` never reaches them.
 */
export default libraryConfig({
  entry: ['src/index.ts', 'src/static.ts'],
  splitting: true,
  // tsup strips `node:` by default, and `node:sqlite` has no unprefixed name: `sqlite` is
  // looked up as a package and the engine can't open a database.
  removeNodeProtocol: false,
});
