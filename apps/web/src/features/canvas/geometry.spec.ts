import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GEOMETRY_DEBOUNCE_MS,
  createGeometryAutosave,
  geometryRequest,
  type GeometryEntry,
} from './geometry';

describe('geometry request', () => {
  it('targets the geometry endpoint and not the ops endpoint', () => {
    const { path, init } = geometryRequest('p1', [{ id: 'e1', position: { x: 0, y: 0 } }]);
    expect(path).toBe('/projects/p1/schema/geometry');
    expect(path).not.toContain('/schema/ops');
    expect(init.method).toBe('POST');
  });

  it('sends no version of any kind — this write neither reads nor bumps one (§8.11)', () => {
    const { init } = geometryRequest('p1', [{ id: 'e1', position: { x: 1, y: 2 } }]);
    const body = init.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['batchId', 'entities']);
    expect(JSON.stringify(body)).not.toContain('ersion');
  });
});

describe('geometry autosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not send until the debounce elapses', () => {
    const send = vi.fn();
    const autosave = createGeometryAutosave(send);
    autosave.queue({ id: 'e1', position: { x: 1, y: 1 } });

    vi.advanceTimersByTime(GEOMETRY_DEBOUNCE_MS - 1);
    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('coalesces a whole drag into one entry with the final position', () => {
    const send = vi.fn<(entries: readonly GeometryEntry[]) => void>();
    const autosave = createGeometryAutosave(send);

    for (let x = 0; x < 50; x += 1) autosave.queue({ id: 'e1', position: { x, y: 0 } });
    vi.advanceTimersByTime(GEOMETRY_DEBOUNCE_MS);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toEqual([{ id: 'e1', position: { x: 49, y: 0 } }]);
  });

  it('batches several entities moved in the same gesture into one send', () => {
    const send = vi.fn<(entries: readonly GeometryEntry[]) => void>();
    const autosave = createGeometryAutosave(send);

    autosave.queue({ id: 'e1', position: { x: 1, y: 0 } });
    autosave.queue({ id: 'e2', position: { x: 2, y: 0 } });
    vi.advanceTimersByTime(GEOMETRY_DEBOUNCE_MS);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it('flushes on demand and then has nothing left to send', () => {
    const send = vi.fn();
    const autosave = createGeometryAutosave(send);
    autosave.queue({ id: 'e1', position: { x: 1, y: 1 } });
    autosave.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(autosave.pending()).toBe(0);
    vi.advanceTimersByTime(GEOMETRY_DEBOUNCE_MS * 2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when the buffer is empty', () => {
    const send = vi.fn();
    createGeometryAutosave(send).flush();
    expect(send).not.toHaveBeenCalled();
  });

  it('cancel drops the buffer without sending', () => {
    const send = vi.fn();
    const autosave = createGeometryAutosave(send);
    autosave.queue({ id: 'e1', position: { x: 1, y: 1 } });
    autosave.cancel();
    vi.advanceTimersByTime(GEOMETRY_DEBOUNCE_MS * 2);
    expect(send).not.toHaveBeenCalled();
  });
});
