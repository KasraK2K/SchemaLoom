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
  {
    // C10's `no-restricted-imports` ban on engine packages has exactly ONE sanctioned
    // exception: the manifest. Doc 01 §4.2 makes it the only file in apps/api that may
    // name a concrete engine, and "adding an engine touches one line" is only true if
    // that line is allowed to exist. A scoped override names the exception in one
    // visible place; an inline disable comment invites the next person to copy it into
    // a second file. Do not widen this.
    files: ['src/engines/engines.manifest.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
];
