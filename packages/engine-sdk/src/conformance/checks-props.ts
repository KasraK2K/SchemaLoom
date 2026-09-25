import { expect } from 'vitest';
import { parseEngineProps } from '../props.js';
import { compareEngineVersion } from '../versioning.js';
import type { ConformanceCheck } from './check.js';
import { NO_SUCH_PROP, PROPS_KINDS, subKindsOf } from './context.js';

/** §6 `engineProps` and §15 versioning — the two places a JSONB bag can quietly rot. */

export const PROPS_CHECKS: readonly ConformanceCheck[] = [
  {
    id: 'props/schemas-are-strict',
    run: ({ engine }) => {
      const problems: string[] = [];
      for (const kind of PROPS_KINDS) {
        for (const subKind of subKindsOf(engine, kind)) {
          const label = `${kind}/${subKind ?? '(none)'}`;
          // `.strict()`, not `.strip()`: an unknown key must 422, because JSONB that
          // silently swallowed junk is unrecoverable a year later, and stripping it on the
          // way in destroys data on a rollback (§15.1).
          if (parseEngineProps(engine, kind, subKind, { [NO_SUCH_PROP]: 1 }).ok) {
            problems.push(`${label} accepted an unknown key`);
          }
          // Every prop is optional: a freshly created object carries `engineProps: {}`.
          if (!parseEngineProps(engine, kind, subKind, {}).ok) {
            problems.push(`${label} rejected an empty bag`);
          }
        }
      }
      expect(problems).toEqual([]);
    },
  },
  {
    id: 'props/reject-invalid',
    run: ({ engine, fixtures }) => {
      expect(fixtures.invalidProps.length).toBeGreaterThan(0);
      const accepted = fixtures.invalidProps
        .filter((f) => parseEngineProps(engine, f.kind, f.subKind, f.value).ok)
        .map((f) => `${f.kind}/${f.subKind ?? '(none)'}`);
      expect(accepted).toEqual([]);

      // A rejection is a DIAGNOSTIC, not a thrown zod error: the inspector highlights
      // `target.propPath`, so the path has to survive.
      for (const fixture of fixtures.invalidProps) {
        const result = parseEngineProps(engine, fixture.kind, fixture.subKind, fixture.value);
        if (result.ok) continue;
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics.every((d) => d.severity === 'error')).toBe(true);
      }
    },
  },
  {
    id: 'props/rollback-is-read-only',
    run: ({ engine }) => {
      // §15.1, as a test. 1.5 ships an optional prop, users set it on a few hundred columns,
      // 1.5 turns out to be buggy, ops rolls back to 1.4 — and a major-only comparison says
      // "ok", so every write to one of those columns hits `.strict()` and 422s with an error
      // the user cannot clear from the UI. The project must open read-only instead.
      const [major = '0', minor = '0'] = engine.version.split('.');
      const newerProject = `${major}.${String(Number.parseInt(minor, 10) + 1)}.0`;

      expect(compareEngineVersion(newerProject, engine)).toEqual({
        action: 'read-only',
        reason: 'project-newer-than-engine',
      });
      expect(compareEngineVersion(engine.version, engine)).toEqual({ action: 'ok' });
      expect(compareEngineVersion(engine.version, undefined)).toEqual({
        action: 'read-only',
        reason: 'engine-missing',
      });
    },
  },
];
