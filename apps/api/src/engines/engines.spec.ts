import type { HttpException } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  DuplicateEngineError,
  FALLBACK_TERMINOLOGY,
  UnknownEngineError,
  constantProps,
  createEngineRegistry,
  createTypeCatalog,
  defineCapabilities,
  type EngineDefinition,
  type EnginePropsSchemas,
  type EngineRegistry,
  type TypeDescriptor,
} from '@schemaloom/engine-sdk';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { RouteSweep } from '../access/route-sweep';
import { COMING_SOON } from './coming-soon.const';
import {
  EngineGate,
  ProjectReadOnlyException,
  assertWritable,
  type ProjectEngineState,
} from './engine-gate.service';
import { EnginesController } from './engines.controller';
import { ENGINE_MANIFEST } from './engines.manifest';
import { EnginesModule } from './engines.module';
import { ENGINE_REGISTRY } from './engines.tokens';

/**
 * A FAKE engine, defined here. `engine-sdk`'s `fixture-engine.ts` is deliberately not
 * exported from its package index, and `@schemaloom/engine-postgresql` must never be imported
 * by core (C10, and the eslint rule that enforces it) — so `apps/api` brings its own.
 *
 * It is minimal on purpose: every feature atom false, so the §4.1 invariant table is satisfied
 * by empty `linkKinds`/`indexTypes` rather than by copying a whole relational engine. Nothing
 * here exercises engine behaviour; the registry and the version gate only ever read `id`,
 * `displayName`, `version`, `paradigm`, `icon`, `summary`, `capabilities` and `terminology`.
 */

const INT_TYPE: TypeDescriptor = {
  id: 'int',
  displayName: 'int',
  category: 'numeric',
  aliases: [],
  parameters: [],
  supportsArray: false,
  preferredForCategory: true,
  deprecated: false,
  summary: 'An integer',
};

const NO_PROPS = constantProps(z.object({}).strict());
const PROPS_SCHEMAS: EnginePropsSchemas = {
  namespace: NO_PROPS,
  entity: NO_PROPS,
  field: NO_PROPS,
  link: NO_PROPS,
  index: NO_PROPS,
  constraint: NO_PROPS,
  customType: NO_PROPS,
  indexColumn: NO_PROPS,
};

interface FakeEngineOptions {
  readonly id?: string;
  readonly displayName?: string;
  readonly version?: string;
}

function fakeEngine(options: FakeEngineOptions = {}): EngineDefinition {
  const id = options.id ?? 'fakesql';
  return {
    id,
    displayName: options.displayName ?? 'Fake SQL',
    version: options.version ?? '1.4.2',
    paradigm: 'relational',
    icon: 'database',
    summary: 'An engine that exists only in this spec',
    capabilities: defineCapabilities({
      engineId: id,
      features: {},
      typeDescriptors: [INT_TYPE],
      namespaces: 'none',
      defaultNamespaceName: null,
      entityKinds: [
        {
          id: 'table',
          shortCode: 'T',
          icon: 'table',
          hasFields: true,
          fieldsAreAuthoritative: true,
          supportsIndexes: false,
          supportsConstraints: false,
          canBeLinkEndpoint: false,
        },
      ],
      linkKinds: [],
      indexTypes: [],
      constraintKinds: [],
      customTypeKinds: [],
      maxFieldDepth: 1,
      identifiers: {
        maxLength: 63,
        caseSensitive: false,
        foldsTo: 'lower',
        quoteOpen: '"',
        quoteClose: '"',
        validUnquoted: '^[a-z_][a-z0-9_$]*$',
        reservedWords: [],
      },
      queryLanguage: {
        id: 'sql',
        displayName: 'SQL',
        fileExtension: 'sql',
        codeMirrorMode: 'sql',
        lineComment: '--',
        statementSeparator: ';',
      },
      importFormats: [],
      exportFormats: [],
    }),
    typeCatalog: createTypeCatalog({
      descriptors: [INT_TYPE],
      arraySyntax: 'none',
      compatibilityGroups: [],
    }),
    terminology: FALLBACK_TERMINOLOGY,
    diagnosticMessages: {},
    propsSchemas: PROPS_SCHEMAS,
    normalizeName: (s) => s.trim().toLowerCase(),
    extractReferences: () => [],
  };
}

/** The controller, over a registry the test controls. */
async function controllerWith(registry: EngineRegistry): Promise<EnginesController> {
  const moduleRef = await Test.createTestingModule({ imports: [EnginesModule] })
    .overrideProvider(ENGINE_REGISTRY)
    .useValue(registry)
    .compile();
  return moduleRef.get(EnginesController);
}

describe('ENGINE_MANIFEST', () => {
  it('names exactly one engine: PostgreSQL, the v1 engine', () => {
    // These two assertions were written against an EMPTY manifest, when the engine
    // package did not exist yet. That premise changed deliberately when the package
    // landed, so they now assert the opposite — that the one line is actually there.
    // The manifest staying at length 1 is the C10 claim under test: a second engine
    // means a second line HERE and nowhere else in apps/api.
    expect(ENGINE_MANIFEST).toHaveLength(1);
    expect(ENGINE_MANIFEST[0]?.id).toBe('postgresql');
  });

  it('serves PostgreSQL as available and the rest as coming soon', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [EnginesModule] }).compile();
    const catalog = moduleRef.get(EnginesController).catalog();

    expect(catalog.available.map((e) => e.id)).toEqual(['postgresql']);

    // A registration SHADOWS an announcement of the same id — otherwise the picker would
    // offer PostgreSQL twice, once greyed out as "coming soon".
    expect(catalog.comingSoon.map((e) => e.id)).not.toContain('postgresql');

    const announcedMinusRegistered = [...COMING_SOON]
      .filter((e) => e.id !== 'postgresql')
      .sort((a, b) => (a.displayName < b.displayName ? -1 : 1));
    expect(catalog.comingSoon.map((e) => e.id)).toEqual(announcedMinusRegistered.map((e) => e.id));
  });
});

describe('the registry EnginesModule builds', () => {
  it('lists available and coming-soon separately, and a registration wins', async () => {
    // Announced as 'mysql' AND registered: it must appear as available, never in both.
    const registry = createEngineRegistry(COMING_SOON);
    registry.register(fakeEngine({ id: 'mysql', displayName: 'MySQL' }));
    const catalog = (await controllerWith(registry)).catalog();

    expect(catalog.available.map((e) => e.id)).toEqual(['mysql']);
    expect(catalog.comingSoon.map((e) => e.id)).not.toContain('mysql');
    expect(catalog.comingSoon).toHaveLength(COMING_SOON.length - 1);
  });

  it('orders both arrays by displayName', async () => {
    const registry = createEngineRegistry(COMING_SOON);
    registry.register(fakeEngine({ id: 'zed', displayName: 'Zed' }));
    registry.register(fakeEngine({ id: 'acme', displayName: 'Acme' }));
    const catalog = (await controllerWith(registry)).catalog();

    expect(catalog.available.map((e) => e.displayName)).toEqual(['Acme', 'Zed']);
    const names = catalog.comingSoon.map((e) => e.displayName);
    expect(names).toEqual([...names].sort());
  });

  it('throws UnknownEngineError for an id nobody registered', () => {
    const registry = createEngineRegistry(COMING_SOON);
    // 'mysql' is ANNOUNCED — an announcement is not a registration.
    expect(() => registry.get('mysql')).toThrow(UnknownEngineError);
    expect(registry.tryGet('mysql')).toBeUndefined();
    expect(registry.has('mysql')).toBe(false);
  });

  it('throws DuplicateEngineError when the manifest lists an engine twice', () => {
    const registry = createEngineRegistry(COMING_SOON);
    registry.register(fakeEngine());
    expect(() => {
      registry.register(fakeEngine());
    }).toThrow(DuplicateEngineError);
  });
});

describe('GET /engines', () => {
  it('returns the catalog shape the picker reads, JSON-serialisable end to end', async () => {
    const registry = createEngineRegistry(COMING_SOON);
    registry.register(fakeEngine());
    const catalog = (await controllerWith(registry)).catalog();

    expect(Object.keys(catalog).sort()).toEqual(['available', 'comingSoon']);
    expect(catalog.available[0]).toMatchObject({
      id: 'fakesql',
      displayName: 'Fake SQL',
      paradigm: 'relational',
      icon: 'database',
      summary: 'An engine that exists only in this spec',
      version: '1.4.2',
    });
    // The picker card needs icon + summary on BOTH arrays, not just the available one.
    const [announced] = catalog.comingSoon;
    expect(typeof announced?.icon).toBe('string');
    expect(typeof announced?.summary).toBe('string');
    // No class instance, no Map, no zod schema leaks into the payload.
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog);
  });

  it('carries exactly one route marker, so the boot sweep lets the process start', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule, EnginesModule],
      providers: [RouteSweep],
    }).compile();
    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['healthz', 'readyz'] });
    try {
      // A missing or doubled marker throws out of onApplicationBootstrap, aborting init().
      await expect(app.init()).resolves.toBeDefined();
    } finally {
      await app.close().catch(() => undefined);
    }
  });
});

describe('engine plugin version drift (doc 03 §15)', () => {
  const gateFor = (engine: EngineDefinition | null): EngineGate => {
    const registry = createEngineRegistry(COMING_SOON);
    if (engine !== null) registry.register(engine);
    return new EngineGate(registry);
  };

  /** The two `project` calls `checkWrite` makes, over one stored version. */
  const txWith = (enginePluginVersion: string) => {
    const update = vi.fn().mockResolvedValue({});
    const tx = {
      project: {
        findFirst: vi.fn().mockResolvedValue({ engineId: 'fakesql', enginePluginVersion }),
        update,
      },
    };
    return { tx: tx as never, update };
  };

  it('checkWrite refuses a write on an older major with 423 and writes nothing', async () => {
    const { tx, update } = txWith('1.4.2');
    await expect(
      gateFor(fakeEngine({ version: '2.0.0' })).checkWrite(tx, 'prj_1'),
    ).rejects.toBeInstanceOf(ProjectReadOnlyException);
    expect(update).not.toHaveBeenCalled();
  });

  it('checkWrite stamps an older same-major version with the running engine version', async () => {
    const { tx, update } = txWith('1.3.9');
    await gateFor(fakeEngine()).checkWrite(tx, 'prj_1');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'prj_1' },
      data: { enginePluginVersion: '1.4.2' },
    });
  });

  it('checkWrite writes nothing when the version is current', async () => {
    const { tx, update } = txWith('1.4.2');
    await gateFor(fakeEngine()).checkWrite(tx, 'prj_1');
    expect(update).not.toHaveBeenCalled();
  });

  it('opens read-write when the stored version matches', () => {
    const state = gateFor(fakeEngine()).resolve({
      engineId: 'fakesql',
      enginePluginVersion: '1.4.2',
    });
    expect(state).toMatchObject({ mode: 'read-write', enginePluginVersion: '1.4.2' });
  });

  it('opens read-write for an older PATCH — a minor/patch bump is backwards compatible', () => {
    const state = gateFor(fakeEngine()).resolve({
      engineId: 'fakesql',
      enginePluginVersion: '1.3.9',
    });
    expect(state).toMatchObject({ mode: 'read-write' });
  });

  it('opens READ-ONLY for an older major — there is no propsMigrations subsystem', () => {
    const state = gateFor(fakeEngine({ version: '2.0.0' })).resolve({
      engineId: 'fakesql',
      enginePluginVersion: '1.4.2',
    });
    expect(state).toMatchObject({
      mode: 'read-only',
      reason: 'project-older-major',
      storedPluginVersion: '1.4.2',
      enginePluginVersion: '2.0.0',
    });
  });

  it('opens READ-ONLY after a rollback, at any semver level (the 1.5 -> 1.4 incident)', () => {
    const state = gateFor(fakeEngine({ version: '1.4.2' })).resolve({
      engineId: 'fakesql',
      enginePluginVersion: '1.5.0',
    });
    expect(state).toMatchObject({ mode: 'read-only', reason: 'project-newer-than-engine' });
  });

  it('opens READ-ONLY, never 500, when the engine package is not deployed', () => {
    const state = gateFor(null).resolve({ engineId: 'fakesql', enginePluginVersion: '1.4.2' });
    expect(state).toMatchObject({
      mode: 'read-only',
      reason: 'engine-missing',
      engine: null,
      enginePluginVersion: null,
    });
  });

  it('refuses a write against a read-only project with 423 and a stable code', () => {
    const state: ProjectEngineState = gateFor(fakeEngine({ version: '2.0.0' })).resolve({
      engineId: 'fakesql',
      enginePluginVersion: '1.4.2',
    });

    let thrown: unknown;
    try {
      assertWritable(state);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProjectReadOnlyException);
    expect((thrown as HttpException).getStatus()).toBe(423);
    expect((thrown as HttpException).getResponse()).toMatchObject({
      code: 'engine.read-only',
      reason: 'project-older-major',
      engineId: 'fakesql',
      storedPluginVersion: '1.4.2',
      enginePluginVersion: '2.0.0',
    });
  });

  it('lets a write through when the project is read-write', () => {
    const state: ProjectEngineState = gateFor(fakeEngine()).resolve({
      engineId: 'fakesql',
      enginePluginVersion: '1.4.2',
    });
    expect(() => {
      assertWritable(state);
    }).not.toThrow();
  });
});
