import { Database } from '@schemaloom/ui';
import Link from 'next/link';
import { ProjectActions } from './project-actions';
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
        // The actions sit beside the link, not inside it: a button nested in an anchor is
        // invalid HTML and its clicks would also navigate.
        <li
          key={project.id}
          className="flex items-center gap-1 rounded-lg border border-border bg-surface pr-2 shadow-panel transition-colors hover:bg-surface-hover"
        >
          <Link
            href={`/${orgSlug}/p/${project.id}`}
            className="flex min-w-0 flex-1 items-center gap-3 p-4"
          >
            <Database className="size-5 shrink-0 text-accent-text" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-text">{project.name}</span>
              <span className="block truncate text-xs text-text-subtle">
                edited{' '}
                <time dateTime={project.updatedAt}>{relativeTime(project.updatedAt, now)}</time>
              </span>
            </span>
            <span className="shrink-0 rounded-full border border-accent-border bg-accent-subtle px-2 py-0.5 font-mono text-xs text-accent-text">
              {project.engineId}
            </span>
            {/* `role: null` means area- or entity-scoped access only (doc 05 §7.9) —
                the caller can open the project but holds no project-level role. */}
            <span className="hidden shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-text-muted capitalize sm:inline">
              {project.role ?? 'scoped'}
            </span>
          </Link>
          {project.role === 'manager' && <ProjectActions id={project.id} name={project.name} />}
        </li>
      ))}
    </ul>
  );
}
