/** The organisations module's public surface. `app.module.ts` imports the module. */
export { OrganizationsModule } from './organizations.module';
export { OrganizationsController } from './organizations.controller';
export { OrganizationsService } from './organizations.service';
export { GroupsService, type GroupView } from './groups.service';
export { MembersService, type DirectoryVia } from './members.service';
export type { OrganizationSummary } from './organizations.types';
