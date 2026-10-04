/**
 * `@schemaloom/engine-sqlite-ui/facet` — the SQLite client facet, as a default export, for
 * `apps/web`'s registry (see the MySQL UI package's facet for why it lives here). SQLite ships
 * no UI plugin of its own yet: the canvas uses the engine-neutral fallback (§16).
 */
export { sqliteFacet as default } from '@schemaloom/engine-sqlite/static';
