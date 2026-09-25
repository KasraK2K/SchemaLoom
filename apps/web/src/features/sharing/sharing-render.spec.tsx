import { Dialog, DialogContent, DialogTitle } from '@schemaloom/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeQueryClient } from '@/lib/query-client';
import {
  ANA,
  BILLING,
  PROJECT,
  RESOURCES,
  ROLES,
  customRole,
  entry,
  grant,
  role,
} from './access-fixture';
import { GrantRow } from './grant-row';
import { GrantWarningNotice } from './grant-warning-notice';
import { previewGrant } from './grant-warnings';
import type { ResourceNoun } from './resource-noun';
import { ShareLinksPanel } from './share-links-panel';

/**
 * Rendering lives here rather than in `packages/ui` for the same reason
 * `button-render.spec.tsx` does: this is where react-dom is installed.
 *
 * `GrantRow` takes its nouns as a prop instead of calling `useTerminology()`, so it
 * renders with no `<EngineProvider>` — the split `EntityBody` uses on the canvas.
 */
const noun: ResourceNoun = (type) =>
  type === 'entity' ? 'Table' : type === 'area' ? 'Area' : 'Project';

const rowProps = {
  scope: BILLING,
  resources: RESOURCES,
  roles: ROLES,
  noun,
  onRoleChange: () => undefined,
  onToggle: () => undefined,
  onRemove: () => undefined,
};

describe('<GrantRow>', () => {
  it('renders an org-admin grant struck through and inert', () => {
    const html = renderToStaticMarkup(
      <GrantRow
        {...rowProps}
        entry={entry(ANA, [grant(ANA, BILLING, 'viewer')], { orgRole: 'admin' })}
      />,
    );
    expect(html).toContain('line-through');
    expect(html).toContain('no effect — org admin');
    expect(html).toContain('data-inert="true"');
    // and the role cannot be changed, because changing it would change nothing
    expect(html).toContain('disabled');
  });

  it('does not strike through an ordinary member', () => {
    const html = renderToStaticMarkup(
      <GrantRow {...rowProps} entry={entry(ANA, [grant(ANA, BILLING, 'viewer')])} />,
    );
    expect(html).not.toContain('line-through');
    expect(html).not.toContain('no effect');
  });

  it('renders a role-implied toggle checked AND disabled, with the reason', () => {
    const analyst = customRole('Analyst', ['schema:view', 'ai:use']);
    const withAi = {
      ...grant(ANA, BILLING, 'viewer'),
      roleKey: analyst.key,
      roleName: analyst.name,
      atoms: analyst.atoms,
    };
    const html = renderToStaticMarkup(
      <GrantRow {...rowProps} roles={[analyst, ...ROLES]} entry={entry(ANA, [withAi])} />,
    );
    const aiBox = /<input[^>]*type="checkbox"[^>]*>/.exec(html)?.[0] ?? '';
    expect(aiBox).toContain('checked');
    expect(aiBox).toContain('disabled');
    expect(html).toContain('always included in Analyst');
  });

  it('leaves a free toggle unchecked and enabled', () => {
    const html = renderToStaticMarkup(
      <GrantRow {...rowProps} entry={entry(ANA, [grant(ANA, BILLING, 'editor')])} />,
    );
    const aiBox = /<input[^>]*type="checkbox"[^>]*>/.exec(html)?.[0] ?? '';
    expect(aiBox).not.toContain('checked');
    expect(aiBox).not.toContain('disabled');
  });

  it('shows where inherited access comes from instead of letting it be edited here', () => {
    const html = renderToStaticMarkup(
      <GrantRow {...rowProps} entry={entry(ANA, [grant(ANA, PROJECT, 'editor')])} />,
    );
    expect(html).toContain('inherited from Project');
  });
});

describe('<GrantWarningNotice>', () => {
  it('renders the §7.7 footgun sentence for the project-Editor + area-Viewer case', () => {
    const warnings = previewGrant(entry(ANA, [grant(ANA, PROJECT, 'editor')]), RESOURCES, {
      target: BILLING,
      role: role('viewer'),
      canUseAi: false,
      canViewRestricted: false,
    });
    const html = renderToStaticMarkup(<GrantWarningNotice warnings={warnings} />);
    expect(html).toContain('data-warning="narrows"');
    expect(html).toContain('Ana is an Editor');
    expect(html).toContain('Billing read-only');
  });

  it('renders nothing when there is nothing to say', () => {
    expect(renderToStaticMarkup(<GrantWarningNotice warnings={[]} />)).toBe('');
  });
});

describe('<ShareLinksPanel>', () => {
  // The panel reads its list through react-query; no effects run under
  // renderToStaticMarkup, so the client is never asked to fetch anything.
  const shareLinksHtml = (): string =>
    renderToStaticMarkup(
      <QueryClientProvider client={makeQueryClient()}>
        <ShareLinksPanel projectId="prj_1" scope={PROJECT} noun={noun} canManage />
      </QueryClientProvider>,
    );

  // R17 caps a share-link session at `schema:view` whatever role the grant names, so a
  // role picker here could only ever promise access the resolver takes away at the door.
  it('offers no role control at all', () => {
    const html = shareLinksHtml();
    expect(html).not.toContain('<select');
    for (const roleName of ['Editor', 'Manager', 'Commenter', 'Documenter']) {
      expect(html).not.toContain(roleName);
    }
    expect(html).toContain('view-only');
  });

  it('offers expiry and password on creation', () => {
    const html = shareLinksHtml();
    expect(html).toContain('type="date"');
    expect(html).toContain('type="password"');
    expect(html).toContain('Create link');
  });
});

describe('the dialog', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./who-has-access-dialog.tsx', import.meta.url)),
    'utf8',
  );

  /**
   * Focus trapping, Escape, the scroll lock and `aria-modal` are Radix's. Asserting them
   * directly needs a DOM these specs do not have, so assert the thing that actually
   * breaks them: somebody rebuilding the modal by hand. Radix's content is portalled, so
   * it renders NOTHING on the server — a hand-rolled overlay would have emitted markup.
   */
  it('renders no modal markup on the server, because the content is Radix’s portal', () => {
    const html = renderToStaticMarkup(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Who has access</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(html).toBe('');
  });

  it('composes the shared Dialog instead of rebuilding one', () => {
    expect(source).toContain("from '@schemaloom/ui'");
    expect(source).toContain('<DialogContent');
    expect(source).toContain('<DialogTitle>');
    expect(source).not.toContain('role="dialog"');
    expect(source).not.toContain('aria-modal=');
    expect(source).not.toContain('onKeyDown');
  });
});
