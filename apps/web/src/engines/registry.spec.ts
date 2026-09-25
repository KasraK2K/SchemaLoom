import { UnknownEngineError } from '@schemaloom/engine-sdk/ui';
import { describe, expect, it, vi } from 'vitest';
import type { EngineUiPlugin } from './contract';
import { FALLBACK_ENGINE_UI } from './fallback';
import { createEngineFacetRegistry, createEngineUiRegistry } from './registry';

const plugin = { engineId: 'demo', nodeRenderers: {}, panels: {} } satisfies EngineUiPlugin;
describe('createEngineUiRegistry', () => {
  it('does not run a loader until someone asks for the engine', () => {
    const registry = createEngineUiRegistry();
    const loader = vi.fn(() => Promise.resolve({ default: plugin }));
    registry.register('demo', loader);
    expect(loader).not.toHaveBeenCalled();
  });

  it('loads the plugin lazily and fetches the chunk once per session', async () => {
    const registry = createEngineUiRegistry();
    const loader = vi.fn(() => Promise.resolve({ default: plugin }));
    registry.register('demo', loader);

    const first = registry.load('demo');
    const second = registry.load('demo');

    // The PROMISE is memoised, not just the value: two components mounting in one tick must
    // not start two fetches, and React's `use()` needs a stable identity.
    expect(second).toBe(first);
    expect(await first).toBe(plugin);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('yields the fallback for an unknown engine id rather than crashing', async () => {
    const registry = createEngineUiRegistry();
    expect(await registry.load('never-registered')).toBe(FALLBACK_ENGINE_UI);
  });

  it('yields the fallback when the chunk fails to load', async () => {
    const registry = createEngineUiRegistry();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    registry.register('broken', () => Promise.reject(new Error('offline chunk')));

    expect(await registry.load('broken')).toBe(FALLBACK_ENGINE_UI);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('keeps registrations independent between registries', async () => {
    const a = createEngineUiRegistry();
    const b = createEngineUiRegistry();
    a.register('demo', () => Promise.resolve({ default: plugin }));
    expect(await b.load('demo')).toBe(FALLBACK_ENGINE_UI);
  });
});

describe('createEngineFacetRegistry', () => {
  it('rejects for an unregistered id — a facet is not optional', async () => {
    const registry = createEngineFacetRegistry();
    await expect(registry.load('never-registered')).rejects.toBeInstanceOf(UnknownEngineError);
  });

  it('memoises the loaded facet', async () => {
    const registry = createEngineFacetRegistry();
    const loaded = { id: 'demo' } as unknown as Awaited<ReturnType<typeof registry.load>>;
    const loader = vi.fn(() => Promise.resolve({ default: loaded }));
    registry.register('demo', loader);

    expect(await registry.load('demo')).toBe(loaded);
    expect(await registry.load('demo')).toBe(loaded);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
