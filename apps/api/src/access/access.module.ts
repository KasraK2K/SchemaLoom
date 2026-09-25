import { Global, Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { PermissionGuard } from './permission.guard';
import { PermissionResolver } from './permission-resolver.service';
import { ResourceIndex } from './resource-index';
import { RouteSweep } from './route-sweep';
import { VisibilityFilter } from './visibility/visibility-filter.service';

/**
 * Doc 05 §7.0 — `AccessModule`.
 *
 * `PrismaModule` and `RedisModule` are both `@Global()` (doc 01 §4), so they are not
 * imported here; `PrismaService` and the `REDIS_CACHE` token resolve from the root
 * injector. Importing them again would create a second, unrelated set of providers.
 *
 * `@Global()` because §4 of doc 01 fixes it that way: `AuthModule` imports `AccessModule`
 * and never the reverse, and every domain module needs the resolver.
 *
 * **Guard order is load-bearing.** Doc 01 §4.1 fixes two global guards, in this order:
 * `JwtAuthGuard` (registered by `app.module.ts`, which answers "who is this?") then
 * `PermissionGuard` (registered here, which answers "may they?"). Nest runs global guards
 * in the order their providers are scanned, and the root module is scanned before its
 * imports — so `JwtAuthGuard` is first and `PermissionGuard` always sees `req.auth`.
 *
 * `RouteSweep` needs no wiring in `app.module.ts`: Nest calls `onApplicationBootstrap`
 * on every provider, and a throw there aborts `app.init()` and the process.
 *
 * `VisibilityFilter` (step 12) is provided and exported here: it is a thin projection of
 * `PermissionResolver` output onto the `VisibilityContext` that `schema-model`'s pure
 * `redact()` consumes, so it belongs beside the resolver it reads. `SchemaLoader` (step
 * 13) plugs in the same way, without changing the resolver or the guard.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    PermissionResolver,
    ResourceIndex,
    RouteSweep,
    { provide: APP_GUARD, useClass: PermissionGuard },
    VisibilityFilter,
  ],
  exports: [PermissionResolver, ResourceIndex, VisibilityFilter],
})
export class AccessModule {}
