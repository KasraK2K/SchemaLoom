import { Module } from '@nestjs/common';
import { AiProvider } from '../ai/ai.provider';
import {
  AiAbilitiesController,
  MyAiIntegrationsController,
  OrgAiIntegrationsController,
  ProjectAiController,
} from './ai-integrations.controller';
import { AiIntegrationsService } from './ai-integrations.service';
import { AiRouter } from './ai-router.service';

/** Prisma, config and the permission resolver are `@Global()`. */
@Module({
  controllers: [
    OrgAiIntegrationsController,
    MyAiIntegrationsController,
    ProjectAiController,
    AiAbilitiesController,
  ],
  providers: [AiIntegrationsService, AiRouter, AiProvider],
  exports: [AiRouter, AiProvider],
})
export class AiIntegrationsModule {}
