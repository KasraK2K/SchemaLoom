import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_JOB_OPTIONS, JobsService, type JobQueues } from './jobs.service';
import {
  JOB_EMAIL_SEND,
  JOB_EXPORT_RENDER,
  JOB_VALIDATE_MODEL,
  type ExportJobData,
} from './queues';

/**
 * No Redis. What matters about enqueuing is WHICH queue, under WHICH job name, with WHICH
 * payload — all three are decided here and none of them needs a server to check.
 */

type AddCall = [name: string, data: unknown, options?: unknown];

type EnqueueQueue = Exclude<keyof JobQueues, 'maintenance'>;

function harness(): { service: JobsService; add: (queue: EnqueueQueue) => AddCall[] } {
  const spies = {
    export: vi.fn((..._args: AddCall) => Promise.resolve({ id: 'bull_1' })),
    email: vi.fn((..._args: AddCall) => Promise.resolve({ id: 'bull_2' })),
    validate: vi.fn((..._args: AddCall) => Promise.resolve({ id: 'bull_3' })),
    import: vi.fn((..._args: AddCall) => Promise.resolve({ id: 'bull_4' })),
  };
  const importJob = {
    data: {
      projectId: 'prj_shop',
      subject: { kind: 'user', userId: 'usr_ana', orgId: 'org_acme' },
      storageKey: 'k',
    },
    returnvalue: { report: {}, existing: [] },
    failedReason: undefined,
    getState: () => Promise.resolve('completed'),
  };
  const queues = {
    export: { add: spies.export },
    email: { add: spies.email },
    validate: { add: spies.validate },
    import: {
      add: spies.import,
      getJob: (id: string) => Promise.resolve(id === 'bull_4' ? importJob : undefined),
    },
  } as unknown as JobQueues;

  return { service: new JobsService(queues), add: (queue) => spies[queue].mock.calls };
}

const EXPORT: ExportJobData = {
  exportJobId: 'exj_1',
  projectId: 'prj_shop',
  subject: { kind: 'user', userId: 'usr_ana', orgId: 'org_acme' },
  format: 'ddl',
};

describe('JobsService', () => {
  it('enqueues an export with its job name and the whole payload', async () => {
    const { service, add } = harness();
    await service.enqueueExport(EXPORT);

    expect(add('export')).toEqual([[JOB_EXPORT_RENDER, EXPORT, DEFAULT_JOB_OPTIONS]]);
    expect(add('email')).toHaveLength(0);
    expect(add('validate')).toHaveLength(0);
  });

  it('carries the subject, so permissions are re-resolved when the job runs', async () => {
    const { service, add } = harness();
    await service.enqueueExport(EXPORT);

    const [, data] = add('export')[0] ?? [];
    expect(data).toMatchObject({ subject: { kind: 'user', userId: 'usr_ana' } });
  });

  it('enqueues email on the email queue', async () => {
    const { service, add } = harness();
    await service.enqueueEmail({
      kind: 'password-reset',
      to: 'ana@example.com',
      name: 'Ana',
      token: 'tok',
    });

    expect(add('email')).toEqual([
      [
        JOB_EMAIL_SEND,
        { kind: 'password-reset', to: 'ana@example.com', name: 'Ana', token: 'tok' },
        DEFAULT_JOB_OPTIONS,
      ],
    ]);
  });

  it('enqueues whole-model validation on the validate queue', async () => {
    const { service, add } = harness();
    const data = {
      projectId: 'prj_shop',
      subject: { kind: 'user', userId: 'usr_ana', orgId: 'org_acme' },
    } as const;
    await service.enqueueValidation(data);

    expect(add('validate')).toEqual([[JOB_VALIDATE_MODEL, data, DEFAULT_JOB_OPTIONS]]);
  });

  it('bounds retention, because the queue instance runs with noeviction', () => {
    // Doc 01 §4.4/§10: an unbounded completed-job list on the one instance that carries
    // the queues reaches maxmemory and Redis starts refusing WRITES — including queue
    // writes. This is the queue's version of the mandatory TTL.
    expect(DEFAULT_JOB_OPTIONS.removeOnComplete).toBeDefined();
    expect(DEFAULT_JOB_OPTIONS.removeOnFail).toBeDefined();
    expect(DEFAULT_JOB_OPTIONS.attempts).toBe(3);
  });

  it('reports an import job only to its owner, in its own project', async () => {
    const { service } = harness();
    expect(await service.importStatus('prj_shop', 'usr_ana', 'bull_4')).toMatchObject({
      state: 'completed',
      error: null,
    });
    expect(await service.importStatus('prj_other', 'usr_ana', 'bull_4')).toBeNull();
    expect(await service.importStatus('prj_shop', 'usr_bob', 'bull_4')).toBeNull();
    expect(await service.importStatus('prj_shop', 'usr_ana', 'nope')).toBeNull();
  });
});
