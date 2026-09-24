import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger, LoggerErrorInterceptor } from 'nestjs-pino';
import { ZodValidationPipe, cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from './app.module';
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
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.useGlobalInterceptors(new LoggerErrorInterceptor());

  const config = app.get<ConfigService<AppEnv, true>>(ConfigService);

  app.use(helmet());
  // Before anything that reads a cookie: the auth guard and the CSRF middleware.
  app.use(cookieMiddleware);

  // SEAM (doc 01 §4.5): the CSRF double-submit middleware mounts here, after cookie
  // parsing, on every unsafe method. It ships with `AuthModule` (step 9), which owns
  // `sl_csrf` issuance — a verifier with nothing issuing the cookie rejects every write.

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
