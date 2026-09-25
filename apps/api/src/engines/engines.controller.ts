import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { EngineCatalog, EngineRegistry } from '@schemaloom/engine-sdk';
import { Authenticated } from '../access';
import { ENGINE_REGISTRY } from './engines.tokens';

@ApiTags('engines')
@Controller('engines')
export class EnginesController {
  constructor(@Inject(ENGINE_REGISTRY) private readonly registry: EngineRegistry) {}

  /**
   * Doc 01 §4.2 — the project-creation picker, registry-driven end to end.
   *
   * Returns both halves: `available` (an engine package is deployed) and `comingSoon`
   * (announced, no registration). The UI renders one card per entry of each array and
   * disables the `comingSoon` ones. **No engine id is ever written in `apps/web`**, so
   * "PostgreSQL enabled, others coming soon" is never hard-coded anywhere.
   *
   * MARKER: `@Authenticated()`, and the choice is deliberate — doc 01 §4.1's boot sweep
   * requires exactly one marker on every `/api/**` route and there is no implicit default.
   * The route names no resource, so it is not `@RequirePermission()`/`@RequireProjectAccess()`
   * and not `@RequireOrgRole()`. It is not `@Public()` either: the only caller is the
   * create-project form, which already needs an identity, and `comingSoon` is an unreleased
   * roadmap that an anonymous scraper has no business reading. `@Authenticated()` is the
   * marker that means exactly "any established identity may call this".
   */
  @ApiOperation({ summary: 'Engines available to create a project with, plus announced ones' })
  @Authenticated()
  @Get()
  catalog(): EngineCatalog {
    return this.registry.catalog();
  }
}
