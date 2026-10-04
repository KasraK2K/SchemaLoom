import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../config/env';
import type { JobQueues } from './jobs.service';
import { JobsRuntime, type Closable } from './jobs.runtime';
import { AUDIT_RETENTION_CRON } from './audit-retention.processor';
import { JOB_AUDIT_RETENTION, QUEUE_EMAIL, QUEUE_EXPORT, QUEUE_VALIDATE } from './queues';

/** Roadmap 20 §1: the process role; `all` unless a test says otherwise. */
const role = (r: 'all' | 'api' | 'worker' = 'all') =>
  ({ get: () => r }) as unknown as ConfigService<AppEnv, true>;

type CloseSpy = ReturnType<typeof vi.fn<() => Promise<void>>>;

interface FakeWorker {
  readonly closable: Closable;
  readonly close: CloseSpy;
}

function worker(name: string, close: () => Promise<void> = () => Promise.resolve()): FakeWorker {
  const spy = vi.fn(close);
  return { closable: { name, close: spy }, close: spy };
}

function fakeQueues(close: () => Promise<void> = () => Promise.resolve()): {
  queues: JobQueues;
  closes: CloseSpy[];
} {
  const closes = [vi.fn(close), vi.fn(close), vi.fn(close), vi.fn(close), vi.fn(close)];
  const queues = {
    export: { close: closes[0] },
    email: { close: closes[1] },
    validate: { close: closes[2] },
    import: { close: closes[3] },
    maintenance: { close: closes[4] },
  } as unknown as JobQueues;
  return { queues, closes };
}

describe('graceful shutdown', () => {
  it('closes every worker', async () => {
    const workers = [worker(QUEUE_EXPORT), worker(QUEUE_EMAIL), worker(QUEUE_VALIDATE)];
    const q = fakeQueues();

    await new JobsRuntime(
      workers.map((w) => w.closable),
      q.queues,
      role(),
    ).onModuleDestroy();

    for (const w of workers) expect(w.close).toHaveBeenCalledTimes(1);
    for (const close of q.closes) expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the other workers when one refuses', async () => {
    const stuck = worker(QUEUE_EXPORT, () => Promise.reject(new Error('still draining')));
    const rest = [worker(QUEUE_EMAIL), worker(QUEUE_VALIDATE)];
    const q = fakeQueues();

    // allSettled, not all: one worker that will not close must not strand the other two
    // with a live blocking read against a connection the app is about to quit.
    await expect(
      new JobsRuntime(
        [stuck.closable, ...rest.map((w) => w.closable)],
        q.queues,
        role(),
      ).onModuleDestroy(),
    ).resolves.toBeUndefined();

    for (const w of rest) expect(w.close).toHaveBeenCalledTimes(1);
  });

  it('closes workers before queues — a worker mid-job still needs the connection', async () => {
    const order: string[] = [];
    const w = worker(QUEUE_EXPORT, () => {
      order.push('worker');
      return Promise.resolve();
    });
    const q = fakeQueues(() => {
      order.push('queue');
      return Promise.resolve();
    });

    await new JobsRuntime([w.closable], q.queues, role()).onModuleDestroy();

    expect(order).toEqual(['worker', 'queue', 'queue', 'queue', 'queue', 'queue']);
  });
});

describe('the audit-retention schedule (doc 00 Q10)', () => {
  it('upserts ONE nightly scheduler by id, so a reboot does not add a second', async () => {
    const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    const queues = { maintenance: { upsertJobScheduler } } as unknown as JobQueues;

    const runtime = new JobsRuntime([], queues, role());
    await runtime.onApplicationBootstrap();
    await runtime.onApplicationBootstrap();

    expect(upsertJobScheduler).toHaveBeenCalledTimes(2);
    for (const [id, repeat, template] of upsertJobScheduler.mock.calls) {
      expect(id).toBe(JOB_AUDIT_RETENTION);
      expect(repeat).toEqual({ pattern: AUDIT_RETENTION_CRON, tz: 'UTC' });
      expect(template).toMatchObject({ name: JOB_AUDIT_RETENTION });
    }
  });
});

describe('process roles (roadmap 20 §1)', () => {
  it('an api process schedules nothing: the worker process owns the schedule', async () => {
    const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    const queues = { maintenance: { upsertJobScheduler } } as unknown as JobQueues;
    await new JobsRuntime([], queues, role('api')).onApplicationBootstrap();
    expect(upsertJobScheduler).not.toHaveBeenCalled();
    await new JobsRuntime([], queues, role('worker')).onApplicationBootstrap();
    expect(upsertJobScheduler).toHaveBeenCalledOnce();
  });
});
