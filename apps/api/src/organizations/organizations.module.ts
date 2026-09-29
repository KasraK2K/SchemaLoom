import { Module } from '@nestjs/common';
import { GroupsService } from './groups.service';
import { MembersService } from './members.service';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { RolesService } from './roles.service';

/**
 * `PrismaModule` and `AccessModule` are `@Global()` (doc 01 §4), so `PrismaService` and
 * `PermissionResolver` resolve from the root injector and are deliberately NOT imported
 * here. Nothing from `ProjectsModule` is injected either — the project list reuses
 * `toSummary`, a pure function, not a provider.
 */
@Module({
  controllers: [OrganizationsController],
  providers: [OrganizationsService, RolesService, MembersService, GroupsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
