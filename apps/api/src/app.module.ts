import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AccessModule } from './access/access.module';
import { AuthModule, JwtAuthGuard } from './auth';
import { EnginesModule } from './engines';
import { JobsModule } from './jobs';
import { OrganizationsModule } from './organizations';
import { ProjectsModule } from './projects';
import { RealtimeModule } from './realtime/realtime.module';
import { SavedQueriesModule } from './saved-queries/saved-queries.module';
import { SchemaModule } from './schema';
import { SharingModule } from './sharing';
import { SnapshotsModule } from './snapshots';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { pinoOptions } from './common/logger/pino.options';
import { AppConfigModule } from './config/config.module';
import type { AppEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';

/**
 * Composition root. Doc 01 §4's module table, minus everything later build-order steps
 * own. The seams they plug into:
 *
 * - `AuthModule` (step 9) — imports `AccessModule`, never the reverse.
 * - `AccessModule` (steps 10-11) `@Global()` — contributes `APP_GUARD` ×2 here, in the
 *   order §4.1 fixes: `JwtAuthGuard` then `PermissionGuard`. Nest runs global guards in
 *   registration order, so that order is load-bearing, not cosmetic.
 * - `AppModule.onApplicationBootstrap()` gains §4.1's mandatory route sweep at the same
 *   time: every route under `/api/**` carries exactly one of the five markers and is
 *   classified against `SHARE_LINK_ROUTES`, or the process refuses to start.
 * - `EnginesModule` (step 15) `@Global()`, fed from `engines.manifest.ts`. NOT a
 *   multi-provider token: Nest has no multi-providers (that is Angular; APP_GUARD's
 *   behaviour comes from a special token, not a general mechanism), so the registry
 *   factory reads the manifest directly. The property that mattered still holds —
 *   the manifest names the engines and `engines.module.ts` names none.
 * - `APP_INTERCEPTOR` (request id) lands with the `common/` step.
 */
@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) =>
        pinoOptions(
          config.get('LOG_LEVEL', { infer: true }),
          config.get('NODE_ENV', { infer: true }) !== 'production',
        ),
    }),
    PrismaModule,
    RedisModule,
    // @Global(); resolves PrismaService and REDIS_CACHE from the two above.
    AccessModule,
    EnginesModule,
    AuthModule,
    // The domain modules. Each was built and unit-tested in isolation, which is
    // exactly why forgetting one here is invisible until the app is booted and its
    // routes are missing from the router table — unit tests mount the module
    // directly and never consult this list.
    OrganizationsModule,
    ProjectsModule,
    SchemaModule,
    SnapshotsModule,
    SharingModule,
    SavedQueriesModule,
    RealtimeModule,
    JobsModule,
    HealthModule,
  ],
  providers: [
    // Guard ORDER is load-bearing, not cosmetic: Nest runs global guards in
    // registration order, and PermissionGuard (step 11) needs the subject that
    // JwtAuthGuard puts on the request. PermissionGuard registers itself from
    // inside AccessModule when it lands, which is why only one entry is here.
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
