import { libraryConfig } from '@schemaloom/config/tsup';

// `./testing` runs each ORM's own checker in tests; it never loads outside a spec.
export default libraryConfig({ entry: ['src/index.ts', 'src/testing.ts'] });
