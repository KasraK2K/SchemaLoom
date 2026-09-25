import { reactConfig } from '@schemaloom/config/eslint/react';

/**
 * The shared config bans `@schemaloom/engine-postgresql` and every subpath of it (C10: core
 * resolves engines through the registry, never by import). This package IS the PostgreSQL
 * engine's browser half, so the subpath ban does not apply to it — but the ROOT entry still
 * does, because that is the server half and it pulls `libpg-query`.
 *
 * Flat config replaces a rule's options wholesale, so both bans are restated here rather than
 * merged: `@schemaloom/engine-sdk` (browser code takes `/ui`), `@schemaloom/engine-postgresql`
 * (take `/static`), and the relative cross-package path ban.
 */
export default [
  ...reactConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@schemaloom/engine-sdk',
              message:
                'Browser code imports @schemaloom/engine-sdk/ui. The root entry is the server half.',
            },
            {
              name: '@schemaloom/engine-postgresql',
              message:
                'This package is the engine’s BROWSER half: import @schemaloom/engine-postgresql/static. The root entry pulls libpg-query.',
            },
          ],
          patterns: [
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
];
