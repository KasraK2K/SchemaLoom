import globals from 'globals';
import tseslint from 'typescript-eslint';
import { baseConfig } from './index.js';

/**
 * React/Next preset. Adds the browser globals and the one boundary rule that
 * matters here: browser code may import an engine's `/static` facet and its UI
 * plugin, but never the server half of an EngineDefinition.
 *
 * @param {{ tsconfigRootDir: string }} opts
 */
export function reactConfig({ tsconfigRootDir }) {
  return tseslint.config(...baseConfig({ tsconfigRootDir }), {
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // engine-sdk's root entry pulls in the server half. Browser code takes /ui.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@schemaloom/engine-sdk',
              message:
                'Browser code imports @schemaloom/engine-sdk/ui (type-only surface). The root entry is the server half and would pull Node built-ins into the bundle.',
            },
          ],
        },
      ],
    },
  });
}

export default reactConfig;
