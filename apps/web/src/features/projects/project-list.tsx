import { Button, Database, FilePlus2, Upload } from '@schemaloom/ui';
import Link from 'next/link';
import type { ProjectSummary } from './projects-api';
import { relativeTime } from './relative-time';

/**
 * One org's projects. Every row links to the canvas at `/[orgSlug]/p/[projectId]` —
 * until this existed, the only way to reach a working canvas was to type a project id
 * into the address bar.
 *
 * `now` is injectable for the same reason `relativeTime` takes it: a row's timestamp is
 * asserted in a test.
 */
export function ProjectList({
  orgSlug,
  projects,
  now,
}: {
  orgSlug: string;
  projects: readonly ProjectSummary[];
  now?: number;
}) {
  return (
    <ul className="mt-6 flex flex-col gap-2">
      {projects.map((project) => (
        <li key={project.id}>
          <Link
            href={`/${orgSlug}/p/${project.id}`}
            className="flex items-center gap-3 rounded-lg border border-border bg-surface p-4 shadow-panel transition-colors hover:bg-surface-hover"
          >
            <Database className="size-5 shrink-0 text-accent-text" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-text">{project.name}</span>
              <span className="block truncate text-xs text-text-subtle">
                edited <time dateTime={project.updatedAt}>{relativeTime(project.updatedAt, now)}</time>
              </span>
            </span>
            <span className="shrink-0 rounded-full border border-accent-border bg-accent-subtle px-2 py-0.5 font-mono text-xs text-accent-text">
              {project.engineId}
            </span>
            {/* `role: null` means area- or entity-scoped access only (doc 05 §7.9) —
                the caller can open the project but holds no project-level role. */}
            <span className="hidden shrink-0 rounded-full border border-border px-2 py-0.5 text-xs capitalize text-text-muted sm:inline">
              {project.role ?? 'scoped'}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

const STARTING_POINTS = [
  {
    icon: FilePlus2,
    title: 'Start blank',
    body: 'An empty canvas. Drop a first table and grow the schema by hand.',
    action: 'New project',
  },
  {
    icon: Upload,
    title: 'Import SQL',
    body: 'Paste a dump or a migration file and start from the schema you already run.',
    action: 'Import',
  },
] as const;

/**
 * A teaching empty state, not a placeholder: "No projects" tells a new user nothing about
 * which ways in exist.
 *
 * Both buttons are `disabled`. `POST /api/projects` exists, but it needs a `workspaceId`
 * and no route lists workspaces yet, so a create form here could not fill its own body.
 * Disabled rather than absent keeps the shape of the screen stable for the change that
 * turns them on.
 */
export function NoProjects() {
  return (
    <ul className="mt-6 grid gap-3 sm:grid-cols-2">
      {STARTING_POINTS.map((point) => (
        <li
          key={point.title}
          className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 shadow-panel"
        >
          <point.icon className="size-5 text-accent-text" aria-hidden="true" />
          <h2 className="text-sm font-medium text-text">{point.title}</h2>
          <p className="text-sm text-text-muted">{point.body}</p>
          <Button variant="outline" size="sm" className="mt-auto self-start" disabled>
            {point.action}
          </Button>
        </li>
      ))}
    </ul>
  );
}
