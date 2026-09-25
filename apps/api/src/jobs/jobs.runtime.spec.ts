import { describe, expect, it, vi } from 'vitest';
import type { JobQueues } from './jobs.service';
import { JobsRuntime, type Closable } from './jobs.runtime';
import { QUEUE_EMAIL, QUEUE_EXPORT, QUEUE_VALIDATE } from './queues';

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
  const closes = [vi.fn(close), vi.fn(close), vi.fn(close)];
  const queues = {
    export: { close: closes[0] },
    email: { close: closes[1] },
    validate: { close: closes[2] },
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
      new JobsRuntime([stuck.closable, ...rest.map((w) => w.closable)], q.queues).onModuleDestroy(),
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

    await new JobsRuntime([w.closable], q.queues).onModuleDestroy();

    expect(order).toEqual(['worker', 'queue', 'queue', 'queue']);
  });
});
