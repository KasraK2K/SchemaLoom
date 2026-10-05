import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NoOrganizations, OrgList } from './org-list';
import { NoProjects } from './create-project';
import { ProjectList } from './project-list';
import { homeDestination, type OrganizationSummary, type ProjectSummary } from './projects-api';
import { relativeTime } from './relative-time';
import { makeQueryClient } from '@/lib/query-client';

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
  engineVersion: '16',
  requireChangeRequests: false,
  tableCount: 12,
  openChangeRequests: 0,
  driftStatus: null,
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
    // No engine names passed: the id stands in, with the version.
    expect(html).toContain('postgresql 16');
    expect(html).toContain('Viewer');
  });

  it('names the engine, and shows the counts and chips the API gave', () => {
    const html = renderToStaticMarkup(
      <ProjectList
        orgSlug="acme"
        engineNames={{ postgresql: 'PostgreSQL' }}
        projects={[
          {
            ...STOREFRONT,
            openChangeRequests: 2,
            requireChangeRequests: true,
            driftStatus: 'drift',
          },
          // A partial viewer: the API counted nothing, so nothing is shown as a number.
          { ...STOREFRONT, id: 'prj_2', tableCount: null, openChangeRequests: null },
        ]}
      />,
    );
    expect(html).toContain('PostgreSQL 16');
    expect(html).toContain('2 open');
    expect(html).toContain('Protected');
    expect(html).toContain('Drift');
    expect(html).toContain('>12<');
    expect(html).toContain('>-<');
  });

  it('says "scoped" rather than nothing when access is area- or entity-scoped', () => {
    const html = renderToStaticMarkup(
      <ProjectList orgSlug="acme" projects={[{ ...STOREFRONT, role: null }]} />,
    );
    expect(html).toContain('Scoped access');
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

/** The create form drafts with AI through React Query, as the app's provider supplies. */
const withQuery = (node: ReactNode) => (
  <QueryClientProvider client={makeQueryClient()}>{node}</QueryClientProvider>
);

describe('<NoProjects>', () => {
  it('teaches the ways in instead of saying "no projects"', () => {
    const html = renderToStaticMarkup(
      withQuery(
        <NoProjects
          orgId="org_1"
          orgSlug="acme"
          engines={[
            {
              id: 'pg',
              displayName: 'PG',
              importFormats: [{ id: 'ddl', fileExtensions: ['.sql'] }],
              connectionFields: [{ id: 'host', label: 'Host', kind: 'text', required: true }],
              introspection: 'network',
              targetVersions: ['16', '15'],
              defaultTargetVersion: '16',
              templates: [{ id: 'shop', title: 'Shop', summary: 'A shop.', tableCount: 3 }],
            },
          ]}
        />,
      ),
    );
    expect(html).toContain('Start blank');
    expect(html).toContain('Import SQL');
    expect(html).toContain('Read a database');
    expect(html).toContain('Start from a template');
    // Every starting point is live once an engine supports it.
    expect(html).not.toContain('disabled=""');
  });

  it('disables "Read a database" and templates when no engine has them', () => {
    const html = renderToStaticMarkup(
      withQuery(
        <NoProjects
          orgId="org_1"
          orgSlug="acme"
          engines={[
            {
              id: 'pg',
              displayName: 'PG',
              importFormats: [{ id: 'ddl', fileExtensions: ['.sql'] }],
              connectionFields: [],
              introspection: 'none',
              targetVersions: [],
              defaultTargetVersion: null,
              templates: [],
            },
          ]}
        />,
      ),
    );
    // "Read a database" and "Start from a template": nothing to connect to, no templates.
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });

  it('offers templates when only the org has one, and not for an outdated one (12c)', () => {
    const engine = {
      id: 'pg',
      displayName: 'PG',
      importFormats: [{ id: 'ddl', fileExtensions: ['.sql'] }],
      connectionFields: [],
      introspection: 'none' as const,
      targetVersions: [],
      defaultTargetVersion: null,
      templates: [],
    };
    const template = {
      id: 'tpl_1',
      name: 'Core schema',
      summary: '',
      engineId: 'pg',
      engineVersion: '16',
      tableCount: 4,
      savedBy: null,
      sourceProjectId: null,
      usable: true,
      canManage: false,
      updatedAt: '2026-10-05T12:00:00.000Z',
    };
    const render = (usable: boolean) =>
      renderToStaticMarkup(
        withQuery(
          <NoProjects
            orgId="org_1"
            orgSlug="acme"
            engines={[engine]}
            orgTemplates={[{ ...template, usable }]}
          />,
        ),
      ).match(/disabled=""/g);
    // Only "Read a database" stays disabled.
    expect(render(true)).toHaveLength(1);
    expect(render(false)).toHaveLength(2);
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
