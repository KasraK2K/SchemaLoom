import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionResolver } from '../access';
import type { SnapshotsService } from '../snapshots';
import type { StorageService } from '../storage';
import { parseRenames } from './import-jobs.controller';
import { ImportProcessor } from './import.processor';

describe('ImportProcessor — confirmed renames on the job path (Phase 4 §2.1)', () => {
  it('hands the payload’s renames to the same importSource the request path uses', async () => {
    const importSource = vi.fn(() => Promise.resolve({ report: {}, existing: ['customers'] }));
    const processor = new ImportProcessor(
      {
        resolveProject: () => Promise.resolve({}),
        skeleton: () => Promise.resolve({}),
        assertAll: () => undefined,
      } as unknown as PermissionResolver,
      { importSource } as unknown as SnapshotsService,
      {
        get: () => Promise.resolve(Buffer.from('CREATE TABLE customers ();')),
        delete: () => Promise.resolve(),
      } as unknown as StorageService,
    );
    const renames = [{ type: 'entity', fromId: 'ent_customer', toName: 'customers' }] as const;

    await processor.run({
      projectId: 'prj_shop',
      subject: { kind: 'user', userId: 'usr_ana', orgId: 'org_acme' },
      storageKey: 'imports/prj_shop/x.sql',
      renames,
    });

    expect(importSource).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'prj_shop' }),
      'CREATE TABLE customers ();',
      expect.any(Number),
      renames,
    );
  });
});

describe('parseRenames', () => {
  it('reads the JSON query parameter, empty when absent', () => {
    expect(parseRenames(undefined)).toEqual([]);
    expect(parseRenames('[{"type":"field","fromId":"f_1","toName":"email_address"}]')).toEqual([
      { type: 'field', fromId: 'f_1', toName: 'email_address' },
    ]);
  });

  it('refuses malformed JSON and a wrong shape with 400', () => {
    expect(() => parseRenames('{nope')).toThrow(BadRequestException);
    expect(() => parseRenames('[{"type":"table","fromId":"x","toName":"y"}]')).toThrow(
      BadRequestException,
    );
  });
});
