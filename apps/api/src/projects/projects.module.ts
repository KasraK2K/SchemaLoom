import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

/**
 * `PrismaModule`, `AccessModule` and `EnginesModule` are all `@Global()` (doc 01 §4), so
 * `PrismaService`, `PermissionResolver` and `ENGINE_REGISTRY` resolve from the root
 * injector and are deliberately NOT imported here — importing them again would create a
 * second set of providers and a second permission cache.
 */
@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
