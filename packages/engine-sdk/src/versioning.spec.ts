import { describe, expect, it } from 'vitest';
import { compareEngineVersion } from './versioning.js';
import { fixtureFacet } from './fixture-engine.js';
import type { EngineStaticFacet } from './definition.js';

const engineAt = (version: string): EngineStaticFacet => ({ ...fixtureFacet, version });

describe('compareEngineVersion', () => {
  it('opens read-only when the engine is not deployed at all', () => {
    expect(compareEngineVersion('1.4.2', undefined)).toEqual({
      action: 'read-only',
      reason: 'engine-missing',
    });
  });

  it('props/rollback-is-read-only — a MINOR rollback is not ok', () => {
    // The §15.1 incident: 1.5 added an optional prop, users set it, ops rolled back to 1.4.
    // Major-only comparison would say ok and then 422 every write on a .strict() schema.
    expect(compareEngineVersion('1.5.0', engineAt('1.4.2'))).toEqual({
      action: 'read-only',
      reason: 'project-newer-than-engine',
    });
  });

  it('a PATCH rollback is read-only too — full semver, not just the major', () => {
    expect(compareEngineVersion('1.4.3', engineAt('1.4.2'))).toEqual({
      action: 'read-only',
      reason: 'project-newer-than-engine',
    });
  });

  it('an older major opens read-only until someone migrates it', () => {
    expect(compareEngineVersion('1.9.9', engineAt('2.0.0'))).toEqual({
      action: 'read-only',
      reason: 'project-older-major',
    });
  });

  it('is ok when the project is at or behind the engine within one major', () => {
    expect(compareEngineVersion('1.4.2', engineAt('1.4.2'))).toEqual({ action: 'ok' });
    expect(compareEngineVersion('1.0.0', engineAt('1.4.2'))).toEqual({ action: 'ok' });
  });

  it('reads an unparseable stored version as 0.0.0, which is read-only rather than ok', () => {
    expect(compareEngineVersion('', engineAt('1.4.2'))).toEqual({
      action: 'read-only',
      reason: 'project-older-major',
    });
  });

  it('ignores a prerelease suffix rather than mis-parsing it', () => {
    expect(compareEngineVersion('1.4.2-rc.1', engineAt('1.4.2'))).toEqual({ action: 'ok' });
  });
});
