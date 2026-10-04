import { Subject } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { bridge, type BusPublisher, type BusSubscriber } from './realtime-bus';

/** One Redis, as far as pub/sub goes: every subscriber hears every publish, in order. */
function broker() {
  const listeners: ((channel: string, message: string) => void)[] = [];
  const subscribed = new Set<string>();
  const publisher: BusPublisher = {
    publish: (channel, message) => {
      if (subscribed.has(channel)) for (const l of listeners) l(channel, message);
      return Promise.resolve(1);
    },
  };
  const subscriber = (): BusSubscriber => ({
    subscribe: (...channels) => {
      for (const c of channels) subscribed.add(c);
      return Promise.resolve(channels.length);
    },
    on: (_event, listener) => listeners.push(listener),
  });
  return { publisher, subscriber };
}

describe('the realtime bus (roadmap 20 §1)', () => {
  it('a worker’s emit reaches an api process’s gateway, and only through Redis', () => {
    const redis = broker();
    // The worker process: publishes, never listens.
    const workerCommits = new Subject<{ seq: number }>();
    const workerHeard: number[] = [];
    workerCommits.subscribe((c) => workerHeard.push(c.seq));
    bridge(redis.publisher, null, 'sl:rt:', { commits: workerCommits });
    // The api process: the gateway subscribes to its own copy of the channel.
    const apiCommits = new Subject<{ seq: number }>();
    const apiHeard: number[] = [];
    apiCommits.subscribe((c) => apiHeard.push(c.seq));
    bridge(redis.publisher, redis.subscriber(), 'sl:rt:', { commits: apiCommits });

    workerCommits.next({ seq: 1 });
    workerCommits.next({ seq: 2 });

    expect(apiHeard).toEqual([1, 2]);
    // Nothing is delivered locally in the worker: there are no sockets there.
    expect(workerHeard).toEqual([]);
  });

  it('an api process hears its own emits once, through Redis, so every replica sees the same stream', () => {
    const redis = broker();
    const notifications = new Subject<{ userId: string; id: string }>();
    const heard: string[] = [];
    notifications.subscribe((n) => heard.push(n.id));
    bridge(redis.publisher, redis.subscriber(), 'sl:rt:', { notifications });

    notifications.next({ userId: 'u1', id: 'n1' });
    expect(heard).toEqual(['n1']);
  });

  it('keeps channels apart, and a different prefix (another environment) hears nothing', () => {
    const redis = broker();
    const devAccess = new Subject<unknown>();
    const devComments = new Subject<unknown>();
    const e2eAccess = new Subject<unknown>();
    const dev: unknown[] = [];
    const devC: unknown[] = [];
    const e2e: unknown[] = [];
    devAccess.subscribe((v) => dev.push(v));
    devComments.subscribe((v) => devC.push(v));
    e2eAccess.subscribe((v) => e2e.push(v));
    bridge(redis.publisher, redis.subscriber(), 'sl:rt:', {
      access: devAccess,
      comments: devComments,
    });
    bridge(redis.publisher, redis.subscriber(), 'sl-e2e:rt:', { access: e2eAccess });

    devAccess.next({ project: 'p1' });
    expect(dev).toEqual([{ project: 'p1' }]);
    expect(devC).toEqual([]);
    expect(e2e).toEqual([]);
  });
});
