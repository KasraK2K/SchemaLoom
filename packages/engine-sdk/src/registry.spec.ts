import { describe, expect, it } from 'vitest';
import { createEngineRegistry, type AnnouncedEngine } from './registry.js';
import { DuplicateEngineError, UnknownEngineError } from './errors.js';
import { fixtureEngine } from './fixture-engine.js';
import type { EngineDefinition } from './definition.js';

const ANNOUNCED: readonly AnnouncedEngine[] = [
  {
    id: 'mongodb',
    displayName: 'MongoDB',
    paradigm: 'document',
    icon: 'leaf',
    summary: 'Collections and documents',
  },
  {
    id: 'fixturesql',
    displayName: 'Fixture SQL',
    paradigm: 'relational',
    icon: 'database',
    summary: 'announced too',
  },
  {
    id: 'neo4j',
    displayName: 'Neo4j',
    paradigm: 'graph',
    icon: 'share-2',
    summary: 'Nodes and relationships',
  },
];

describe('EngineRegistry', () => {
  it('registers and looks up by id', () => {
    const registry = createEngineRegistry(ANNOUNCED);
    registry.register(fixtureEngine);
    expect(registry.has('fixturesql')).toBe(true);
    expect(registry.get('fixturesql')).toBe(fixtureEngine);
    expect(registry.tryGet('fixturesql')).toBe(fixtureEngine);
    expect(registry.list()).toEqual([fixtureEngine]);
  });

  it('throws DuplicateEngineError on a repeated id', () => {
    const registry = createEngineRegistry([]);
    registry.register(fixtureEngine);
    expect(() => {
      registry.register(fixtureEngine);
    }).toThrow(DuplicateEngineError);
    try {
      registry.register(fixtureEngine);
    } catch (error) {
      expect((error as DuplicateEngineError).code).toBe('engine.duplicate');
      expect((error as DuplicateEngineError).engineId).toBe('fixturesql');
    }
  });

  it('throws UnknownEngineError for an unregistered id, and tryGet returns undefined', () => {
    const registry = createEngineRegistry(ANNOUNCED);
    expect(() => registry.get('mongodb')).toThrow(UnknownEngineError);
    expect(registry.tryGet('mongodb')).toBeUndefined();
    try {
      registry.get('mongodb');
    } catch (error) {
      expect((error as UnknownEngineError).code).toBe('engine.unknown');
    }
  });

  it('lists a "coming soon" engine for the picker but will not resolve it for work', () => {
    const registry = createEngineRegistry(ANNOUNCED);
    registry.register(fixtureEngine);
    const catalog = registry.catalog();

    // The picker is registry-driven: announced ids with no registration are advertised...
    expect(catalog.comingSoon.map((e) => e.id)).toEqual(['mongodb', 'neo4j']);
    // ...and registration always wins over the announcement, so shipping an engine needs no
    // edit to the announcement list.
    expect(catalog.available.map((e) => e.id)).toEqual(['fixturesql']);
    expect(catalog.comingSoon.some((e) => e.id === 'fixturesql')).toBe(false);

    // But a coming-soon engine cannot be resolved for work.
    expect(registry.has('neo4j')).toBe(false);
    expect(() => registry.get('neo4j')).toThrow(UnknownEngineError);
  });

  it('describes an available engine as pure JSON, with no services attached', () => {
    const registry = createEngineRegistry([]);
    registry.register(fixtureEngine);
    const descriptor = registry.catalog().available[0];
    expect(descriptor).toMatchObject({
      id: 'fixturesql',
      displayName: 'Fixture SQL',
      paradigm: 'relational',
      version: '1.4.2',
    });
    expect(descriptor).not.toHaveProperty('extractReferences');
    expect(descriptor).not.toHaveProperty('propsSchemas');
    expect(descriptor).not.toHaveProperty('typeCatalog');
    expect(descriptor?.templates).toEqual([]);
  });

  it('lists template metadata, never the source (Phase 12)', () => {
    const registry = createEngineRegistry([]);
    registry.register({
      ...fixtureEngine,
      templates: [
        {
          id: 'shop',
          title: 'Shop',
          summary: 'A shop.',
          tableCount: 2,
          importFormat: 'ddl',
          source: 'CREATE TABLE a (id int);',
        },
      ],
    });
    expect(registry.catalog().available[0]?.templates).toEqual([
      { id: 'shop', title: 'Shop', summary: 'A shop.', tableCount: 2 },
    ]);
  });

  it('keeps registration order for available engines and sorts the announced ones', () => {
    const registry = createEngineRegistry(ANNOUNCED);
    const second: EngineDefinition = { ...fixtureEngine, id: 'aaa', displayName: 'AAA SQL' };
    registry.register(fixtureEngine);
    registry.register(second);
    // The first registered engine is the picker's default, so order is deployment policy.
    expect(registry.catalog().available.map((e) => e.displayName)).toEqual([
      'Fixture SQL',
      'AAA SQL',
    ]);
    expect(registry.catalog().comingSoon.map((e) => e.displayName)).toEqual(['MongoDB', 'Neo4j']);
  });
});
