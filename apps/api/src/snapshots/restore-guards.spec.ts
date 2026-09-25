import { ForbiddenException } from '@nestjs/common';
import type { EngineDefinition, EngineRegistry } from '@schemaloom/engine-sdk';
import type { VisibilityContext } from '@schemaloom/schema-model';
import { describe, expect, it } from 'vitest';
import { EngineGate, ProjectReadOnlyException } from '../engines';
import { fullContext } from '../schema/fixture';
import {
  SnapshotEngineMismatchException,
  assertFullProjectView,
  assertSnapshotEngine,
} from './restore-guards';

const gateAt = (version: string | null): EngineGate =>
  new EngineGate({
    tryGet: () => (version === null ? undefined : ({ version } as unknown as EngineDefinition)),
  } as unknown as EngineRegistry);

const project = (enginePluginVersion: string) => ({ engineId: 'postgresql', enginePluginVersion });

/** A context is built from a model; an empty one is enough for the two set comparisons. */
const context = (over: Partial<VisibilityContext>): VisibilityContext =>
  fullContext(
    {
      irVersion: 1,
      projectId: 'prj_shop',
      engineId: 'postgresql',
      engineVersion: '16',
      redacted: false,
      objects: {
        area: {},
        namespace: {},
        customType: {},
        entity: {},
        field: {},
        constraint: {},
        index: {},
        link: {},
      },
    },
    over,
  );

describe('assertSnapshotEngine — doc 03 §15.2', () => {
  it('restores a snapshot written under an older PATCH of the same major', () => {
    expect(() => {
      assertSnapshotEngine(gateAt('1.4.2'), project('1.4.2'), '1.4.0');
    }).not.toThrow();
  });

  it('restores a snapshot written under a NEWER minor of the same major', () => {
    // A project opens read-only when its own stored version is newer at any level (a
    // rollback can leave rows the current schema rejects). A snapshot is inert data, and
    // §15.2 is explicit: same major proceeds.
    expect(() => {
      assertSnapshotEngine(gateAt('1.4.2'), project('1.4.2'), '1.5.0');
    }).not.toThrow();
  });

  it('refuses a snapshot from an older MAJOR', () => {
    expect(() => {
      assertSnapshotEngine(gateAt('2.0.0'), project('2.0.0'), '1.9.9');
    }).toThrow(SnapshotEngineMismatchException);
  });

  it('refuses a snapshot from a newer MAJOR', () => {
    expect(() => {
      assertSnapshotEngine(gateAt('1.4.2'), project('1.4.2'), '2.0.0');
    }).toThrow(SnapshotEngineMismatchException);
  });

  it('refuses before that if the project itself is read-only (423, not 422)', () => {
    expect(() => {
      assertSnapshotEngine(gateAt('2.0.0'), project('1.0.0'), '2.0.0');
    }).toThrow(ProjectReadOnlyException);
  });

  it('refuses when the engine is not registered at all', () => {
    expect(() => {
      assertSnapshotEngine(gateAt(null), project('1.4.2'), '1.4.2');
    }).toThrow(ProjectReadOnlyException);
  });
});

describe('assertFullProjectView — doc 05 R21′', () => {
  it('passes for a subject who sees the whole project', () => {
    expect(() => {
      assertFullProjectView(
        context({
          visibleEntityIds: new Set(['ent_a', 'ent_b']),
          restrictedOkEntityIds: new Set(['ent_a']),
          totalEntityCount: 2,
          entitiesWithRestrictedFields: new Set(['ent_a']),
        }),
      );
    }).not.toThrow();
  });

  it('refuses a subject who cannot see every entity', () => {
    expect(() => {
      assertFullProjectView(
        context({ visibleEntityIds: new Set(['ent_a']), totalEntityCount: 2 }),
      );
    }).toThrow(ForbiddenException);
  });

  it('refuses a subject who cannot read every restricted field', () => {
    expect(() => {
      assertFullProjectView(
        context({
          visibleEntityIds: new Set(['ent_a']),
          restrictedOkEntityIds: new Set(),
          totalEntityCount: 1,
          entitiesWithRestrictedFields: new Set(['ent_a']),
        }),
      );
    }).toThrow(ForbiddenException);
  });
});
