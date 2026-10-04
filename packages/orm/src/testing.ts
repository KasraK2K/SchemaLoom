import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Phase 8 §4 — "the output compiles", checked by each ORM's own tool. Test-only: engines call
 * these from their specs with their own fixtures. The tools resolve from this package's dev
 * dependencies, so an engine needs none of them. Each throws with the tool's output.
 */

const require = createRequire(import.meta.url);

const run = (args: readonly string[], env: Record<string, string> = {}): void => {
  try {
    execFileSync(process.execPath, args, {
      env: { ...process.env, ...env },
      stdio: 'pipe',
    });
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(`${String(stdout ?? '')}${String(stderr ?? '')}`);
  }
};

const URLS = {
  postgresql: 'postgresql://u:p@localhost:5432/db',
  mysql: 'mysql://u:p@localhost:3306/db',
  sqlite: 'file:./dev.db',
} as const;

/**
 * `tsc --noEmit` over a Drizzle or TypeORM file, strict, with decorators on. The file is
 * written under this package's `node_modules`, so `drizzle-orm` and `typeorm` resolve.
 */
export function checkTypeScript(text: string): void {
  // `dist/testing.js` → this package's own `node_modules`, where pnpm links the ORMs.
  const root = fileURLToPath(new URL('../node_modules/.sl-orm-check', import.meta.url));
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'ts-'));
  writeFileSync(join(dir, 'schema.ts'), text);
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'es2022',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        experimentalDecorators: true,
        skipLibCheck: true,
        types: [],
      },
      files: ['schema.ts'],
    }),
  );
  run([require.resolve('typescript/bin/tsc'), '-p', join(dir, 'tsconfig.json')]);
}

/**
 * `python -m django check` over a `models.py` in a throwaway app. Returns false, having checked
 * nothing, when Python or Django isn't installed (Q5: CI installs it). `SL_PYTHON` picks the
 * interpreter, e.g. a venv's.
 */
export function checkDjango(text: string): boolean {
  const python = process.env.SL_PYTHON ?? 'python';
  try {
    execFileSync(python, ['-c', 'import django'], { stdio: 'pipe' });
  } catch {
    return false;
  }
  const dir = mkdtempSync(join(tmpdir(), 'sl-django-'));
  mkdirSync(join(dir, 'app'));
  writeFileSync(join(dir, 'app', '__init__.py'), '');
  writeFileSync(join(dir, 'app', 'models.py'), text);
  writeFileSync(
    join(dir, 'settings.py'),
    [
      "SECRET_KEY = 'check'",
      "INSTALLED_APPS = ['app']",
      "DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}",
      "DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'",
      '',
    ].join('\n'),
  );
  try {
    execFileSync(
      python,
      ['-m', 'django', 'check', '--settings=settings', '--fail-level', 'WARNING'],
      {
        cwd: dir,
        env: { ...process.env, PYTHONPATH: dir },
        stdio: 'pipe',
      },
    );
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(`${String(stdout ?? '')}${String(stderr ?? '')}`);
  }
  return true;
}

export function checkPrisma(text: string, provider: keyof typeof URLS): void {
  const dir = mkdtempSync(join(tmpdir(), 'sl-orm-'));
  const file = join(dir, 'schema.prisma');
  writeFileSync(file, text);
  const cli = join(require.resolve('prisma/package.json'), '..', 'build', 'index.js');
  run([cli, 'validate', '--schema', file], {
    DATABASE_URL: URLS[provider],
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
  });
}
