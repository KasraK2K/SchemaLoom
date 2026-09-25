import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The plugin's imports must not reach the engine's SERVER entry.
 *
 * The engine's own `static-boundary.spec.ts` walks `/static`'s transitive graph and proves it
 * never touches `libpg-query`. What that cannot see is THIS package reaching past it: one
 * `from '@schemaloom/engine-postgresql'` anywhere in here puts the WASM parser in the canvas
 * bundle, and nothing else would fail until a user waits for it.
 *
 * A source scan rather than a module-graph walk, because the failure is a specifier and this
 * catches it in a file that never runs (a panel rendered only for materialized views) as
 * readily as in one that does.
 */
const SRC = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    // Specs are not shipped, and this file necessarily names the forbidden specifier.
    if (entry.name.includes('.spec.')) return [];
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** `from '<specifier>'` and `import('<specifier>')`, single or double quoted. */
function specifiersIn(source: string): string[] {
  return [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');
}

describe('import boundary', () => {
  const files = sourceFiles(SRC);

  it('finds the package sources', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('never imports the engine’s server entry', () => {
    const offenders = files.filter((file) =>
      specifiersIn(readFileSync(file, 'utf8')).includes('@schemaloom/engine-postgresql'),
    );
    expect(offenders).toEqual([]);
  });

  it('imports the engine only through its /static facet', () => {
    const engineSpecifiers = new Set(
      files.flatMap((file) =>
        specifiersIn(readFileSync(file, 'utf8')).filter((s) =>
          s.startsWith('@schemaloom/engine-postgresql'),
        ),
      ),
    );
    expect([...engineSpecifiers]).toEqual(['@schemaloom/engine-postgresql/static']);
  });

  it('never imports the SDK’s root entry', () => {
    const offenders = files.filter((file) =>
      specifiersIn(readFileSync(file, 'utf8')).includes('@schemaloom/engine-sdk'),
    );
    expect(offenders).toEqual([]);
  });
});
