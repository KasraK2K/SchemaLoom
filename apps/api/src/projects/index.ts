/**
 * The projects module's public surface. `app.module.ts` imports `ProjectsModule`; the
 * organisations module imports the two view helpers so a project row looks the same in a
 * list as it does on its own.
 */
export { ProjectsModule } from './projects.module';
export { ProjectsController } from './projects.controller';
export { ProjectsService } from './projects.service';
export { CreateProjectDto, CreateProjectSchema } from './projects.dto';
export { effectiveRole } from './effective-role';
export { slugify } from './slugify';
export {
  toDetail,
  toSummary,
  type ProjectDetail,
  type ProjectDetailRow,
  type ProjectSummary,
  type ProjectSummaryRow,
} from './project-views';
