import { readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The boundary the whole browser story rests on (doc 03 §1.1).
 *
 * `apps/web` imports `@schemaloom/engine-postgresql/static`. If anything in that import
 * graph ever picks up a Node built-in or `libpg-query` — a multi-megabyte WASM build of
 * the PostgreSQL parser — the browser bundle breaks, and it breaks SILENTLY: nothing
 * fails until the canvas stops loading, long after the commit that did it.
 *
 * So the graph is walked here, statically, from the source rather than the bundle: a
 * bundle-size budget notices the megabytes but not the first cheap Node import, and this
 * test runs in milliseconds on every commit.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

/** Comments are stripped first — this very file, and `static.ts`, MENTION libpg-query. */
function sourceOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, '$1');
}

/** The `from` of a real import/export must follow whitespace or a closing brace — which
 *  is what keeps the string `'from'` in `reserved-words.ts` out of the results. */
const FROM_RE = /(?:^|[\s}])from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiers(source: string, pattern: RegExp): readonly string[] {
  return [...source.matchAll(pattern)].map((m) => m[1] ?? '');
}

interface Graph {
  /** every source file reachable by STATIC import */
  readonly files: ReadonlySet<string>;
  /** bare specifiers reached by STATIC import */
  readonly external: ReadonlySet<string>;
  /** bare specifiers reached by `import()` — a separate chunk, never in the entry bundle */
  readonly dynamicExternal: ReadonlySet<string>;
}

function walk(entry: string): Graph {
  const files = new Set<string>();
  const external = new Set<string>();
  const dynamicExternal = new Set<string>();
  const queue = [resolve(SRC, entry)];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || files.has(file)) continue;
    files.add(file);
    const source = sourceOf(file);

    for (const specifier of [
      ...specifiers(source, FROM_RE),
      ...specifiers(source, SIDE_EFFECT_RE),
    ]) {
      if (!specifier.startsWith('.')) {
        external.add(specifier);
        continue;
      }
      queue.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
    }

    for (const specifier of specifiers(source, DYNAMIC_RE)) {
      if (!specifier.startsWith('.')) dynamicExternal.add(specifier);
    }
  }

  return { files, external, dynamicExternal };
}

const NODE_BUILTINS = new Set(builtinModules);

const isNodeBuiltin = (specifier: string): boolean =>
  specifier.startsWith('node:') || NODE_BUILTINS.has(specifier);

describe('the ./static entry is browser-safe', () => {
  const graph = walk('static.ts');

  it('reaches more than just itself, so the walk is actually walking', () => {
    expect(graph.files.size).toBeGreaterThan(5);
  });

  it('imports no Node built-in, anywhere in its transitive graph', () => {
    expect([...graph.external].filter(isNodeBuiltin)).toEqual([]);
  });

  it('imports nothing but the SDK and zod', () => {
    expect([...graph.external].sort()).toEqual(['@schemaloom/engine-sdk', 'zod']);
  });

  it('never reaches the parser module', () => {
    expect([...graph.files].filter((f) => f.endsWith('parser.ts'))).toEqual([]);
    expect(graph.external.has('libpg-query')).toBe(false);
    expect(graph.dynamicExternal.has('libpg-query')).toBe(false);
  });

  it('loads nothing lazily either — a dynamic chunk is still a chunk to ship', () => {
    expect([...graph.dynamicExternal]).toEqual([]);
  });
});

describe('the "." entry keeps the parser behind a dynamic import', () => {
  const graph = walk('index.ts');

  it('reaches the parser module', () => {
    expect([...graph.files].some((f) => f.endsWith('parser.ts'))).toBe(true);
  });

  it('reaches libpg-query ONLY through import()', () => {
    expect(graph.external.has('libpg-query')).toBe(false);
    expect(graph.dynamicExternal.has('libpg-query')).toBe(true);
  });
});

describe('no source file statically imports the parser', () => {
  const sources = readdirSync(SRC)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
    .map((name) => resolve(SRC, name));

  it.each(sources.map((file) => [file.slice(SRC.length + 1), file]))('%s', (_name, file) => {
    const source = sourceOf(file);
    expect(specifiers(source, FROM_RE)).not.toContain('libpg-query');
    expect(specifiers(source, SIDE_EFFECT_RE)).not.toContain('libpg-query');
  });
});
