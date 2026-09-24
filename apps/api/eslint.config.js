import { baseConfig } from '@schemaloom/config/eslint';

export default [
  ...baseConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    // A Nest module IS a decorator-only class — that is the framework's DI shape, not
    // a namespace someone should have written as functions. Same for the handful of
    // decorator-only classes Nest asks for (filters, guards) that carry no state.
    files: ['**/*.module.ts'],
    rules: { '@typescript-eslint/no-extraneous-class': 'off' },
  },
];
