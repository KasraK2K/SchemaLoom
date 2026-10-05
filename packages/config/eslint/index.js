import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Base flat config. Type-aware rules are on, which is why `lint` dependsOn
 * `^build` and `db:generate` in turbo.json — the dependency .d.ts files and the
 * generated Prisma client must exist before this can run.
 *
 * Flat config has no .eslintignore, so every ignore lives here.
 */
export const ignores = {
  ignores: [
    '**/dist/**',
    '**/.next/**',
    '**/.turbo/**',
    '**/coverage/**',
    // tsup's temporary config bundle; a parallel build deletes it mid-lint.
    '**/tsup.config.bundled_*',
    '**/node_modules/**',
    '**/generated/**',
    'docs/**',
    // Build config lives outside every tsconfig `include`, so type-aware rules
    // cannot parse it. Linting it buys nothing — it is declarative and tsc
    // already checks the .ts ones when they are imported.
    '**/*.config.js',
    '**/*.config.ts',
    '**/*.config.mjs',
  ],
};

/** @param {{ tsconfigRootDir: string }} opts */
export function baseConfig({ tsconfigRootDir }) {
  return tseslint.config(
    ignores,
    js.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir },
        globals: { ...globals.node },
      },
      rules: {
        // The IR and engineProps are genuinely dynamic at their boundaries; the zod
        // schemas are the guard, so a bare `any` is a real smell but an unavoidable
        // cast at a parse boundary is not.
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
        ],
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
        // Enforces C10: nothing outside an engine package may import one directly.
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['@schemaloom/engine-postgresql', '@schemaloom/engine-postgresql/*'],
                message:
                  'Core code must resolve engines through the EngineRegistry by project.engineId, never by importing one. See C10 / doc 03 §engine registry.',
              },
              {
                group: ['../../*', '../../../*'],
                message:
                  'Cross-package imports use the package name, never a relative path. @/* is the only alias.',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['**/*.spec.ts', '**/*.spec.tsx', '**/*.int.spec.ts'],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
      },
    },
    prettier,
  );
}

export default baseConfig;
