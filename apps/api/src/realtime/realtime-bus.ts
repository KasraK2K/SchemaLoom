import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { PermissionResolver } from '../access';
import { CommentsService } from '../comments';
import type { AppEnv } from '../config/env';
import { NotificationsService } from '../notifications';
import { createRedisClient } from '../redis/redis.factory';
import { SchemaCommits } from '../schema';

/**
 * Roadmap 20 §1 — the realtime bus. The gateway reads four in-process channels (schema
 * commits, access changes, comment changes, new notifications). A job in a separate worker
 * process, or a write on another api replica, emits on ITS copy of those channels, which
 * reaches no socket. With `REALTIME_BUS=redis` every emit goes through Redis pub/sub instead,
 * and every api process feeds what it receives into its own channel, where the gateway
 * redacts per socket exactly as before. Raw events cross Redis, never rendered frames: the
 * per-socket `view` that redaction needs lives only in the process holding the socket, which
 * is why the Socket.IO Redis adapter doesn't fit.
 *
 * The channels' `next` is replaced in one place rather than at every emit site, so no writer
 * changes and there is no second publishing path to forget. Redis keeps the order of one
 * publisher's messages on a channel, so a project's commits arrive in `seq` order; a frame
 * lost in transit is healed by the client's seq-gap refetch, as for any dropped frame.
 *
 * With `REALTIME_BUS=local` (the default) this does nothing.
 */
@Injectable()
export class RealtimeBus implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeBus.name);
  private readonly clients: Redis[] = [];

  constructor(
    private readonly config: ConfigService<AppEnv, true>,
    private readonly commits: SchemaCommits,
    private readonly resolver: PermissionResolver,
    private readonly comments: CommentsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    if (this.config.get('REALTIME_BUS', { infer: true }) !== 'redis') return;
    const url = this.config.get('REDIS_URL', { infer: true });
    const prefix = this.config.get('REDIS_KEY_PREFIX', { infer: true });
    // A subscribed connection can do nothing else, so the bus has its own two.
    const publisher = createRedisClient('cache', url, prefix);
    this.clients.push(publisher);
    // A worker process holds no sockets: it publishes and never listens.
    const subscriber =
      this.config.get('PROCESS_ROLE', { infer: true }) === 'worker'
        ? null
        : createRedisClient('cache', url, prefix);
    if (subscriber !== null) this.clients.push(subscriber);

    // Pub/sub channel names are not key-prefixed by ioredis, so the prefix goes in by hand:
    // a dev api and an e2e api on one Redis must not hear each other.
    bridge(publisher, subscriber, `${prefix}rt:`, {
      commits: this.commits.results,
      access: this.resolver.accessChanged,
      comments: this.comments.changed,
      notifications: this.notifications.created,
    });
    this.logger.log(
      `realtime bus on Redis (${subscriber === null ? 'publish only' : 'publish and listen'})`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.clients.map((c) => c.quit()));
  }
}

/** Pub/sub's two halves, as much of ioredis as the bridge uses (a spec passes a fake). */
export interface BusPublisher {
  publish(channel: string, message: string): Promise<unknown>;
}
export interface BusSubscriber {
  subscribe(...channels: string[]): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
}

/** An rxjs `Subject`, as far as the bridge cares. Method syntax, so any `Subject<T>` fits. */
export interface Nextable {
  next(value: unknown): void;
}

/**
 * Re-routes each subject's `next` through Redis. Every value is JSON (commit results, scopes,
 * targets and ids are plain data), so nothing is lost on the wire.
 */
export function bridge(
  publisher: BusPublisher,
  subscriber: BusSubscriber | null,
  prefix: string,
  subjects: Record<string, Nextable>,
): void {
  const deliver = new Map<string, (value: unknown) => void>();
  for (const [name, subject] of Object.entries(subjects)) {
    const local = subject.next.bind(subject);
    const channel = `${prefix}${name}`;
    deliver.set(channel, local);
    subject.next = (value: unknown) => {
      void publisher.publish(channel, JSON.stringify(value)).catch(() => undefined);
    };
  }
  if (subscriber === null) return;
  subscriber.on('message', (channel, message) => {
    deliver.get(channel)?.(JSON.parse(message) as unknown);
  });
  void subscriber.subscribe(...deliver.keys());
}
