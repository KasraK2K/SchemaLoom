import { Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { EngineCatalog, EngineRegistry } from '@schemaloom/engine-sdk';
import { Authenticated } from '../access';
import { ENGINE_REGISTRY } from './engines.tokens';

@ApiTags('engines')
@Controller('engines')
export class EnginesController {
  constructor(@Inject(ENGINE_REGISTRY) private readonly registry: EngineRegistry) {}

  @ApiOperation({ summary: 'Engines available to create a project with, plus announced ones' })
  @Authenticated()
  @Get()
  catalog(): EngineCatalog {
    return this.registry.catalog();
  }

  /**
   * Phase 12 — a template's SQL, which the web app then sends through the ordinary
   * `POST /projects/:id/import`. Engine data, not project data: nothing to permission-check
   * beyond being signed in, like the catalog above.
   */
  @ApiOperation({ summary: 'The source of one engine template (Phase 12)' })
  @Authenticated()
  @Get(':engineId/templates/:templateId')
  template(
    @Param('engineId') engineId: string,
    @Param('templateId') templateId: string,
  ): { importFormat: string; source: string } {
    const template = this.registry
      .tryGet(engineId)
      ?.templates?.find((candidate) => candidate.id === templateId);
    if (template === undefined) throw new NotFoundException({ code: 'template.not_found' });
    return { importFormat: template.importFormat, source: template.source };
  }
}
