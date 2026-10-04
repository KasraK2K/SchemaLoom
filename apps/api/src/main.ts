import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import helmet from 'helmet';
import { Logger, LoggerErrorInterceptor } from 'nestjs-pino';
import { ZodValidationPipe, cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from './app.module';
import { createCsrfMiddleware } from './auth';
import { cookieMiddleware } from './common/cookies.middleware';
import type { AppEnv } from './config/env';

/*
 * Doc 01 §3.1 asks for `patchNestJsSwagger()`, which does not exist in nestjs-zod
 * v5 — it monkey-patched `@nestjs/swagger/dist/services/schema-object-factory`,
 * an internal path v11 stopped exporting, so calling it crashes the process at
 * import time. v5 replaces it with `cleanupOpenApiDoc`, applied to the GENERATED
 * document rather than to swagger's internals (see below). Same outcome — every
 * schema derives from the zod object the global `ZodValidationPipe` validates
 * against — with no reliance on another package's private layout.
 */

async function bootstrap(): Promise<void> {
  // `bufferLogs` holds start-up lines until pino is wired, so a boot failure is
  // logged in the same format as everything else.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  // Doc 00 Q22: SQL import is synchronous up to 5 MB of source, which arrives JSON-encoded.
  // Express's 100 KB default also rejected large `schema/ops` batches (MAX_OPS_PER_BATCH).
  app.useBodyParser('json', { limit: '6mb' });
  // Larger sources go to the import job as raw `text/plain` (`import-jobs.controller.ts`).
  app.useBodyParser('text', { limit: '50mb' });
  // Roadmap 14: the SAML ACS is an HTML form post from the IdP.
  app.useBodyParser('urlencoded', { extended: false, limit: '1mb' });
  app.useLogger(app.get(Logger));
  app.useGlobalInterceptors(new LoggerErrorInterceptor());

  const config = app.get<ConfigService<AppEnv, true>>(ConfigService);
  // Roadmap 20 §1: the worker role has its own entry, with no HTTP server at all.
  if (config.get('PROCESS_ROLE', { infer: true }) === 'worker')
    throw new Error('PROCESS_ROLE=worker runs dist/worker.js, not dist/main.js');
  // Phase 13 §5 — an uploaded database file arrives as `application/octet-stream`.
  app.useBodyParser('raw', {
    limit: config.get('INTROSPECT_UPLOAD_MAX_BYTES', { infer: true }),
  });

  // Behind a load balancer every request's socket peer is the balancer, so without this
  // the per-IP rate limits (share-link unlock) would throttle all visitors as one.
  app.set('trust proxy', config.get('TRUST_PROXY', { infer: true }));

  app.use(helmet());
  // Q23: a worst-case 300-table IR is ~2.1 MB of JSON and ~380 KB gzipped (ir-size.spec).
  // The AI stream is skipped: gzip buffers it, so tokens would stop arriving one by one.
  app.use(
    compression({
      filter: (req, res) =>
        !String(res.getHeader('Content-Type') ?? '').startsWith('text/event-stream') &&
        compression.filter(req, res),
    }),
  );
  // Before anything that reads a cookie: the auth guard and the CSRF middleware.
  app.use(cookieMiddleware);

  // Doc 01 §4.5: verifies the sl_csrf double-submit token on every unsafe method.
  // AuthModule owns issuance; this is the other half. Both ship together — a verifier
  // with nothing issuing the cookie would reject every write.
  app.use(createCsrfMiddleware(config.get('CSRF_SECRET', { infer: true })));

  app.enableCors({
    origin: config.get('CORS_ORIGINS', { infer: true }),
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
  });

  // The probes stay off the prefix: an orchestrator's liveness path must not move
  // when the API's prefix does.
  app.setGlobalPrefix('api', { exclude: ['healthz', 'readyz'] });
  app.useGlobalPipes(new ZodValidationPipe());

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('SchemaLoom API')
      .setDescription('Visual database design workspace.')
      .setVersion('0.0.0')
      .addCookieAuth('sl_access')
      .build(),
  );
  // Resolves the zod-derived schemas in place of the `$ref`s nestjs-zod emits.
  SwaggerModule.setup('api/docs', app, cleanupOpenApiDoc(document));

  // Lets `onModuleDestroy`/`onApplicationShutdown` run: Prisma disconnects and the
  // three Redis clients quit instead of being severed mid-command.
  app.enableShutdownHooks();

  await app.listen(config.get('PORT', { infer: true }));
}

void bootstrap();
