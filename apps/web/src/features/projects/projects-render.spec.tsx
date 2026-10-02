import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NoOrganizations, OrgList } from './org-list';
import { NoProjects } from './create-project';
import { ProjectList } from './project-list';
import { homeDestination, type OrganizationSummary, type ProjectSummary } from './projects-api';
import { relativeTime } from './relative-time';

/**
 * Rendering lives next to the components rather than in `packages/ui` for the same
 * reason `button-render.spec.tsx` does: this is where react-dom is installed.
 *
 * The payloads are literals, not fetches — these components take everything as props so
 * the page owns the network and the markup can be asserted without one.
 */
const ACME: OrganizationSummary = {
  id: 'org_1',
  slug: 'acme',
  name: 'Acme Inc',
  orgRole: 'member',
};
const GLOBEX: OrganizationSummary = {
  id: 'org_2',
  slug: 'globex',
  name: 'Globex',
  orgRole: 'guest',
};

const STOREFRONT: ProjectSummary = {
  id: 'prj_seed_demo_storefront1',
  name: 'Storefront',
  engineId: 'postgresql',
  updatedAt: '2026-09-25T10:00:00.000Z',
  role: 'viewer',
};

describe('<OrgList>', () => {
  it('renders a row per organisation, linking to its project list', () => {
    const html = renderToStaticMarkup(<OrgList orgs={[ACME, GLOBEX]} />);
    expect(html).toContain('href="/acme"');
    expect(html).toContain('Acme Inc');
    expect(html).toContain('href="/globex"');
    expect(html).toContain('Globex');
    expect(html).toContain('guest');
  });
});

describe('<NoOrganizations>', () => {
  it('offers to create one instead of reading as an error', () => {
    const html = renderToStaticMarkup(<NoOrganizations />);
    expect(html).toContain('New organisation');
    expect(html).not.toContain('went wrong');
  });
});

describe('homeDestination', () => {
  it('redirects straight into a single organisation', () => {
    expect(homeDestination([ACME])).toEqual({ kind: 'redirect', href: '/acme' });
  });

  it('shows the picker when there is a choice to make', () => {
    expect(homeDestination([ACME, GLOBEX])).toEqual({ kind: 'list' });
  });

  it('shows the empty state rather than redirecting nowhere', () => {
    expect(homeDestination([])).toEqual({ kind: 'empty' });
  });
});

describe('<ProjectList>', () => {
  it('links each project to the canvas at /[orgSlug]/p/[projectId]', () => {
    const html = renderToStaticMarkup(<ProjectList orgSlug="acme" projects={[STOREFRONT]} />);
    expect(html).toContain('href="/acme/p/prj_seed_demo_storefront1"');
    expect(html).toContain('Storefront');
    expect(html).toContain('postgresql');
    expect(html).toContain('viewer');
  });

  it('says "scoped" rather than nothing when access is area- or entity-scoped', () => {
    const html = renderToStaticMarkup(
      <ProjectList orgSlug="acme" projects={[{ ...STOREFRONT, role: null }]} />,
    );
    expect(html).toContain('scoped');
  });

  it('renders the edit time as words against a machine-readable timestamp', () => {
    const html = renderToStaticMarkup(
      <ProjectList
        orgSlug="acme"
        projects={[STOREFRONT]}
        now={Date.parse('2026-09-25T12:00:00.000Z')}
      />,
    );
    expect(html).toContain('dateTime="2026-09-25T10:00:00.000Z"');
    expect(html).toContain('2 hours ago');
  });
});

describe('<NoProjects>', () => {
  it('teaches the ways in instead of saying "no projects"', () => {
    const html = renderToStaticMarkup(
      <NoProjects
        orgId="org_1"
        orgSlug="acme"
        engines={[
          {
            id: 'pg',
            displayName: 'PG',
            importFormats: [{ id: 'ddl', fileExtensions: ['.sql'] }],
            connectionFields: [{ id: 'host', label: 'Host', kind: 'text', required: true }],
            targetVersions: ['16', '15'],
            defaultTargetVersion: '16',
          },
        ]}
      />,
    );
    expect(html).toContain('Start blank');
    expect(html).toContain('Import SQL');
    expect(html).toContain('Read a database');
    // Every starting point is live once an engine supports it.
    expect(html).not.toContain('disabled=""');
  });

  it('disables "Read a database" when no engine has a connection form', () => {
    const html = renderToStaticMarkup(
      <NoProjects
        orgId="org_1"
        orgSlug="acme"
        engines={[
          {
            id: 'pg',
            displayName: 'PG',
            importFormats: [{ id: 'ddl', fileExtensions: ['.sql'] }],
            connectionFields: [],
            targetVersions: [],
            defaultTargetVersion: null,
          },
        ]}
      />,
    );
    expect(html.match(/disabled=""/g)).toHaveLength(1);
  });
});

describe('relativeTime', () => {
  it('reports an unparseable timestamp rather than NaN', () => {
    expect(relativeTime('not a date')).toBe('unknown');
  });

  it('collapses anything under a minute', () => {
    expect(relativeTime('2026-09-25T12:00:00.000Z', Date.parse('2026-09-25T12:00:30.000Z'))).toBe(
      'just now',
    );
  });
});
