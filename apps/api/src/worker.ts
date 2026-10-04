import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { AppEnv } from './config/env';

/**
 * Roadmap 20 §1 (`docs/phase20/DESIGN.md`) — the worker process: `node dist/worker.js` with
 * `PROCESS_ROLE=worker` and `REALTIME_BUS=redis`. The same modules as the api, so a job runs
 * exactly the code it runs in-process, but an application context instead of an HTTP app: no
 * port, no routes, no WebSocket server. It runs the BullMQ workers and owns the schedules;
 * its events reach browsers through the realtime bus.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const role = app.get<ConfigService<AppEnv, true>>(ConfigService).get('PROCESS_ROLE', {
    infer: true,
  });
  if (role !== 'worker') {
    await app.close();
    throw new Error(`dist/worker.js needs PROCESS_ROLE=worker (it is ${role})`);
  }
  // Workers close before Redis quits (see `JobsRuntime`), so a deploy doesn't cut a job.
  app.enableShutdownHooks();
  app.get(Logger).log('worker started');
}

void bootstrap();
