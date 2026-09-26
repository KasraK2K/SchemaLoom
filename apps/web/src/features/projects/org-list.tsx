import { Button, LayoutGrid } from '@schemaloom/ui';
import Link from 'next/link';
import type { OrganizationSummary } from './projects-api';

/**
 * The organisation picker. Presentational and prop-driven: the page does the fetching and
 * the redirect, this renders a list, so both halves are testable without a network and
 * without an RSC harness.
 */
export function OrgList({ orgs }: { orgs: readonly OrganizationSummary[] }) {
  return (
    <ul className="mt-6 flex flex-col gap-2">
      {orgs.map((org) => (
        <li key={org.id}>
          <Link
            href={`/${org.slug}`}
            className="flex items-center gap-3 rounded-lg border border-border bg-surface p-4 shadow-panel transition-colors hover:bg-surface-hover"
          >
            <LayoutGrid className="size-5 shrink-0 text-accent-text" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-text">{org.name}</span>
              <span className="block truncate font-mono text-xs text-text-subtle">{org.slug}</span>
            </span>
            <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs capitalize text-text-muted">
              {org.orgRole}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Zero organisations is a real state — the window between registering and joining a
 * first one — so it gets a prompt rather than an error.
 *
 * The button is `disabled` rather than absent because there is no `POST /organizations`
 * yet: an enabled control would be a link to a 404, which teaches the user less than a
 * control that is visibly not ready. Same reasoning, and same shape, as the canvas's own
 * teaching empty state.
 */
export function NoOrganizations() {
  return (
    <div className="mt-6 rounded-lg border border-border bg-surface p-6 text-center shadow-panel">
      <h2 className="text-sm font-medium text-text">You are not in an organisation yet</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-text-muted">
        Projects live inside an organisation. Create one to start designing, or ask a
        colleague to invite you to theirs.
      </p>
      <Button variant="primary" size="sm" className="mt-4" disabled>
        New organisation
      </Button>
    </div>
  );
}
