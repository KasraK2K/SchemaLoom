'use client';

import { Button } from '@schemaloom/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import { apiFetch, apiUrl } from '@/lib/api-client';

/** `GET /organizations/:slug/audit-log` — `apps/api/src/organizations/audit-log.service.ts`. */
const AuditRowSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  action: z.string(),
  actor: z
    .object({
      id: z.string().nullable(),
      name: z.string().nullable(),
      email: z.string().nullable(),
    })
    .nullable(),
  project: z.object({ id: z.string(), name: z.string() }).nullable(),
  resourceType: z.string().nullable(),
  resourceId: z.string().nullable(),
  ip: z.string().nullable(),
  metadata: z.unknown(),
});
const AuditPageSchema = z.object({
  rows: z.array(AuditRowSchema),
  nextCursor: z.string().nullable(),
});
type AuditRow = z.infer<typeof AuditRowSchema>;

/** Action groups for the filter; the value is the prefix the api matches. */
const GROUPS = [
  { prefix: '', label: 'All actions' },
  { prefix: 'auth.', label: 'Sign-ins' },
  { prefix: 'org_member.', label: 'Members' },
  { prefix: 'grant.', label: 'Access grants' },
  { prefix: 'share_link.', label: 'Share links' },
  { prefix: 'api_token.', label: 'API tokens' },
  { prefix: 'project.', label: 'Project settings' },
  { prefix: 'user.', label: 'Account security' },
  { prefix: 'sso_connection.', label: 'Single sign-on' },
] as const;

/** `grant.updated` → "grant updated"; good enough without a table of every action. */
const describe = (action: string): string => action.replace(/[._]/g, ' ');

interface Filters {
  readonly action: string;
  readonly actor: string;
  readonly projectId: string;
  readonly from: string;
  readonly to: string;
}

function query(filters: Filters, before?: string): string {
  const params = new URLSearchParams();
  if (filters.action !== '') params.set('action', filters.action);
  if (filters.actor !== '') params.set('actor', filters.actor);
  if (filters.projectId !== '') params.set('projectId', filters.projectId);
  if (filters.from !== '') params.set('from', new Date(filters.from).toISOString());
  // "to" is a whole day: up to the start of the next one.
  if (filters.to !== '')
    params.set('to', new Date(new Date(filters.to).getTime() + 86_400_000).toISOString());
  if (before !== undefined) params.set('before', before);
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

const select = 'rounded-md border border-border bg-surface px-2 py-1 text-sm text-text';

export function AuditLog({
  orgSlug,
  people,
  projects,
}: {
  readonly orgSlug: string;
  readonly people: readonly { readonly id: string; readonly label: string }[];
  readonly projects: readonly { readonly id: string; readonly name: string }[];
}) {
  const [filters, setFilters] = useState<Filters>({
    action: '',
    actor: '',
    projectId: '',
    from: '',
    to: '',
  });
  const base = `/organizations/${encodeURIComponent(orgSlug)}/audit-log`;
  const log = useInfiniteQuery({
    queryKey: ['audit-log', orgSlug, filters],
    queryFn: async ({ pageParam }) =>
      AuditPageSchema.parse(await apiFetch<unknown>(`${base}${query(filters, pageParam)}`)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows: AuditRow[] = log.data?.pages.flatMap((p) => p.rows) ?? [];
  const set = (key: keyof Filters) => (e: { target: { value: string } }) => {
    setFilters((f) => ({ ...f, [key]: e.target.value }));
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2" role="group" aria-label="Filters">
        <select
          aria-label="Action"
          className={select}
          value={filters.action}
          onChange={set('action')}
        >
          {GROUPS.map((g) => (
            <option key={g.prefix} value={g.prefix}>
              {g.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Person"
          className={select}
          value={filters.actor}
          onChange={set('actor')}
        >
          <option value="">Everyone</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Project"
          className={select}
          value={filters.projectId}
          onChange={set('projectId')}
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs text-text-muted">
          From
          <input type="date" className={select} value={filters.from} onChange={set('from')} />
        </label>
        <label className="flex items-center gap-1 text-xs text-text-muted">
          To
          <input type="date" className={select} value={filters.to} onChange={set('to')} />
        </label>
        <a
          href={apiUrl(`${base}.csv${query(filters)}`)}
          className="ml-auto text-sm text-accent-text underline underline-offset-2"
        >
          Download CSV
        </a>
      </div>

      {log.error !== null && (
        <p role="alert" className="text-sm text-danger-text">
          Could not load the audit log.
        </p>
      )}

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-surface-sunken text-xs text-text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Who</th>
              <th className="px-3 py-2 font-medium">What</th>
              <th className="px-3 py-2 font-medium">Where</th>
              <th className="px-3 py-2 font-medium">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.id} className="align-top">
                <td className="px-3 py-2 whitespace-nowrap text-text-muted">
                  <time dateTime={r.createdAt}>{new Date(r.createdAt).toLocaleString()}</time>
                </td>
                <td className="px-3 py-2">
                  {r.actor === null ? (
                    <span className="text-text-muted">SchemaLoom</span>
                  ) : (
                    <>
                      <span className="text-text">
                        {r.actor.name ?? r.actor.email ?? 'deleted user'}
                      </span>
                      {r.ip !== null && (
                        <span className="block text-xs text-text-muted">{r.ip}</span>
                      )}
                    </>
                  )}
                </td>
                <td className="px-3 py-2 text-text">{describe(r.action)}</td>
                <td className="px-3 py-2 text-text-muted">
                  {r.project?.name ?? r.resourceType ?? '—'}
                </td>
                <td className="px-3 py-2">
                  <details>
                    <summary className="cursor-pointer text-xs text-text-muted">Show</summary>
                    <pre className="mt-1 max-w-xs overflow-auto font-mono text-[11px] text-text">
                      {JSON.stringify(
                        {
                          resource: `${r.resourceType ?? ''} ${r.resourceId ?? ''}`.trim(),
                          ...(r.metadata as object),
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {log.isPending && <p className="p-3 text-sm text-text-subtle">Loading…</p>}
        {!log.isPending && rows.length === 0 && (
          <p className="p-3 text-sm text-text-muted">Nothing matches these filters.</p>
        )}
      </div>

      {log.hasNextPage && (
        <Button
          variant="outline"
          className="self-start"
          disabled={log.isFetchingNextPage}
          onClick={() => {
            void log.fetchNextPage();
          }}
        >
          {log.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  );
}
