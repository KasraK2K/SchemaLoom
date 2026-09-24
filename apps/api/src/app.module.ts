import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AccessModule } from './access/access.module';
import { AuthModule, JwtAuthGuard } from './auth';
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
 * - `EnginesModule` (step 15) `@Global()`, fed from the `ENGINE_DEFINITION` multi-token.
 * - `APP_FILTER` (AllExceptionsFilter) and `APP_INTERCEPTOR` (request id) land with the
 *   `common/` step.
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
    AuthModule,
    HealthModule,
  ],
  providers: [
    // Guard ORDER is load-bearing, not cosmetic: Nest runs global guards in
    // registration order, and PermissionGuard (step 11) needs the subject that
    // JwtAuthGuard puts on the request. PermissionGuard registers itself from
    // inside AccessModule when it lands, which is why only one entry is here.
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
  ],
})
export class AppModule {}
