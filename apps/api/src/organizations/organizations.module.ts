import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { AuditLogService } from './audit-log.service';
import { WorkspaceGrantsService } from './workspace-grants.service';
import { GroupsService } from './groups.service';
import { MemberInvitesService } from './member-invites.service';
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
  imports: [MailModule],
  controllers: [OrganizationsController],
  providers: [
    OrganizationsService,
    RolesService,
    MembersService,
    GroupsService,
    MemberInvitesService,
    AuditLogService,
    WorkspaceGrantsService,
  ],
  exports: [OrganizationsService, MembersService, GroupsService],
})
export class OrganizationsModule {}
