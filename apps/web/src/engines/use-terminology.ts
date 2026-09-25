'use client';

import {
  formatMessage,
  resolveTerm,
  type CoreMessageId,
  type Term,
  type TermSubject,
} from '@schemaloom/engine-sdk/ui';
import { useMemo } from 'react';
import { useEngine } from './engine-provider';

export interface Terminology {
  /** `t.msg('action.add', 'entity')` — "Add table" for PostgreSQL, "Add collection" for
   *  MongoDB. Core owns the VERB (the message catalog); the engine owns only the NOUN. */
  msg: (
    id: CoreMessageId,
    subject: TermSubject,
    vars?: Readonly<Record<string, string | number>>,
  ) => string;
  /** the noun itself, for the rare slot a template cannot express */
  term: (subject: TermSubject) => Term;
}

/**
 * §16.2 — nothing in the UI hard-codes a noun.
 *
 * Singular, plural and verb forms all come from here: `CORE_MESSAGE_TEMPLATES` supplies the
 * sentence, the engine's `TerminologyBundle` supplies the word, and the formatter lowercases
 * for mid-sentence slots so an engine never stores two casings of the same noun.
 *
 * Enforced, not merely documented: `no-hardcoded-nouns.test.ts` walks `apps/web/src` and
 * `packages/engine-sdk/src` with the TypeScript compiler API and fails on a literal "table",
 * "column" or "collection" in a JSX text node or a `t.msg`-shaped argument.
 */
export function useTerminology(): Terminology {
  const { terminology } = useEngine();
  return useMemo<Terminology>(
    () => ({
      msg: (id, subject, vars) => formatMessage(terminology, id, subject, vars),
      term: (subject) => resolveTerm(terminology, subject),
    }),
    [terminology],
  );
}
