'use client';

import { Database, Search, ShieldCheck, TriangleAlert, cn } from '@schemaloom/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ProjectActions } from './project-actions';
import type { ProjectSummary } from './projects-api';
import { relativeTime } from './relative-time';

const COLUMNS =
  'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 md:grid-cols-[minmax(0,1fr)_10rem_4.5rem_6.5rem_7rem_2rem]';

/**
 * "PostgreSQL 16" from the engine's name and the project's target version. A version
 * that already names its product ("MariaDB 11.4") stands alone. Names come from
 * `GET /engines` (the page passes them): no engine id is written here.
 */
function engineLabel(project: ProjectSummary, names: Readonly<Record<string, string>>): string {
  const name = names[project.engineId] ?? project.engineId;
  const version = project.engineVersion;
  if (version === '') return name;
  return /^[a-z]/i.test(version) ? version : `${name} ${version}`;
}

const ROLE_LABEL: Record<string, string> = {
  viewer: 'Viewer',
  commenter: 'Commenter',
  editor: 'Editor',
  manager: 'Manager',
};

/**
 * One org's projects as a table. Every row links to the canvas at `/[orgSlug]/p/[projectId]`.
 * The counts are `null` for a caller without a complete view (the API decides), and show
 * as a dash rather than a zero that would be a lie.
 *
 * `now` is injectable for the same reason `relativeTime` takes it: a row's timestamp is
 * asserted in a test.
 */
export function ProjectList({
  orgSlug,
  projects,
  engineNames = {},
  now,
}: {
  orgSlug: string;
  projects: readonly ProjectSummary[];
  engineNames?: Readonly<Record<string, string>>;
  now?: number;
}) {
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const shown =
    needle === '' ? projects : projects.filter((p) => p.name.toLowerCase().includes(needle));

  return (
    <section aria-label="Projects" className="flex min-w-0 flex-col gap-3">
      <label className="flex h-8 w-full max-w-72 items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-sm focus-within:border-accent-border">
        <Search className="size-4 shrink-0 text-text-subtle" aria-hidden="true" />
        <span className="sr-only">Filter projects by name</span>
        <input
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
          }}
          placeholder="Filter by name"
          className="min-w-0 flex-1 bg-transparent text-text outline-none placeholder:text-text-subtle"
        />
      </label>

      <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-panel">
        <div
          aria-hidden="true"
          className={cn(
            COLUMNS,
            'h-9 bg-surface-sunken text-xs font-medium text-text-subtle max-md:hidden',
          )}
        >
          <span>Project</span>
          <span>Engine</span>
          <span>Tables</span>
          <span>Requests</span>
          <span>Edited</span>
          <span />
        </div>
        <ul>
          {shown.map((project) => (
            // The actions sit beside the link, not inside it: a button nested in an anchor
            // is invalid HTML and its clicks would also navigate.
            <li
              key={project.id}
              className="relative border-t border-border transition-colors first:border-t-0 hover:bg-surface-hover md:first:border-t"
            >
              <div className={cn(COLUMNS, 'min-h-14 py-2.5')}>
                <Link
                  href={`/${orgSlug}/p/${project.id}`}
                  // Stretched link: the whole row opens the project.
                  className="flex min-w-0 items-center gap-3 after:absolute after:inset-0"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-sunken text-text-muted">
                    <Database className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-text">{project.name}</span>
                      {project.requireChangeRequests && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-px text-[0.6875rem] font-medium text-text-muted">
                          <ShieldCheck className="size-3" aria-hidden="true" />
                          Protected
                        </span>
                      )}
                      {project.driftStatus === 'drift' && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning-subtle px-2 py-px text-[0.6875rem] font-medium text-warning-text">
                          <TriangleAlert className="size-3" aria-hidden="true" />
                          Drift
                        </span>
                      )}
                    </span>
                    {/* `role: null` means area- or entity-scoped access only (doc 05 §7.9):
                        the caller can open the project but holds no project-level role. */}
                    <span className="block truncate text-xs text-text-subtle">
                      {project.role === null
                        ? 'Scoped access'
                        : (ROLE_LABEL[project.role] ?? project.role)}
                      <span className="md:hidden">
                        {' · '}
                        <time dateTime={project.updatedAt}>
                          {relativeTime(project.updatedAt, now)}
                        </time>
                      </span>
                    </span>
                  </span>
                </Link>
                <span className="truncate text-sm text-text-muted max-md:hidden">
                  {engineLabel(project, engineNames)}
                </span>
                <span className="font-mono text-xs text-text-muted max-md:hidden">
                  {project.tableCount ?? '-'}
                </span>
                <span className="max-md:hidden">
                  {project.openChangeRequests === null ? (
                    <span className="text-sm text-text-subtle">-</span>
                  ) : project.openChangeRequests > 0 ? (
                    <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-xs font-medium text-accent-text">
                      {project.openChangeRequests} open
                    </span>
                  ) : (
                    <span className="text-sm text-text-subtle">None</span>
                  )}
                </span>
                <span className="text-sm text-text-subtle max-md:hidden">
                  <time dateTime={project.updatedAt}>{relativeTime(project.updatedAt, now)}</time>
                </span>
                {/* Above the stretched link, so the menu opens instead of the project. */}
                <span className="relative z-10 justify-self-end">
                  {project.role === 'manager' && (
                    <ProjectActions id={project.id} name={project.name} />
                  )}
                </span>
              </div>
            </li>
          ))}
          {shown.length === 0 && (
            <li className="px-4 py-8 text-center text-sm text-text-muted">
              No project matches “{filter.trim()}”.
            </li>
          )}
        </ul>
      </div>
    </section>
  );
}
