import type { SchemaModel } from '@schemaloom/schema-model';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { irQueryKey } from './ir-query';
import { CUSTOMERS, ORDERS, fixtureModel } from './model-fixture';
import { applyPatch, handlePatch, isGap, usePresenceStore, type PatchFrame } from './realtime';

const PROJECT = 'prj_1';

const renamed = (model: SchemaModel, seq: number): PatchFrame => ({
  projectId: PROJECT,
  seq,
  changed: { entity: { [ORDERS]: { ...model.objects.entity[ORDERS]!, name: 'purchases', version: 9 } } },
  removed: [{ type: 'entity', id: CUSTOMERS }],
});

const seeded = () => {
  const client = new QueryClient();
  const model = fixtureModel();
  client.setQueryData(irQueryKey(PROJECT), model);
  const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
  const current = () => client.getQueryData<SchemaModel>(irQueryKey(PROJECT));
  return { client, model, invalidate, current };
};

describe('applyPatch', () => {
  it('replaces post-images and deletes removals, leaving the input untouched', () => {
    const model = fixtureModel();
    const next = applyPatch(model, renamed(model, 1));
    expect(next.objects.entity[ORDERS]?.name).toBe('purchases');
    expect(next.objects.entity[CUSTOMERS]).toBeUndefined();
    expect(model.objects.entity[ORDERS]?.name).not.toBe('purchases');
  });
});

describe('seq gaps (doc 04 §8.7)', () => {
  it('isGap: one ahead applies, a repeat applies (geometry), two ahead refetches', () => {
    expect(isGap(4, 5)).toBe(false);
    expect(isGap(4, 4)).toBe(false);
    expect(isGap(4, 6)).toBe(true);
    expect(isGap(null, 1)).toBe(true);
  });

  it('a contiguous frame is merged into the IR cache', () => {
    const { client, model, invalidate, current } = seeded();
    expect(handlePatch(client, PROJECT, 4, renamed(model, 5))).toBe(5);
    expect(current()?.objects.entity[ORDERS]?.name).toBe('purchases');
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('a gap refetches the IR instead of applying', () => {
    const { client, model, invalidate, current } = seeded();
    expect(handlePatch(client, PROJECT, 4, renamed(model, 7))).toBe(7);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: irQueryKey(PROJECT) });
    expect(current()?.objects.entity[ORDERS]?.name).not.toBe('purchases');
  });

  it('ignores another project’s frame and a malformed one', () => {
    const { client, model, invalidate } = seeded();
    expect(handlePatch(client, PROJECT, 4, { ...renamed(model, 5), projectId: 'prj_2' })).toBe(4);
    expect(handlePatch(client, PROJECT, 4, { seq: 'x' })).toBe(4);
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('presence store', () => {
  it('drops a peer that left or cleared its selection', () => {
    const { set } = usePresenceStore.getState();
    set({ peerId: 'p1', userId: 'u1', name: 'Ana', selection: [ORDERS], left: false });
    expect(usePresenceStore.getState().peers.size).toBe(1);
    set({ peerId: 'p1', userId: 'u1', name: 'Ana', selection: [], left: true });
    expect(usePresenceStore.getState().peers.size).toBe(0);
  });
});
