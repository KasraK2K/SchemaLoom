'use client';

import { Button } from '@schemaloom/ui';
import { useRouter } from 'next/navigation';
import { useState, type SyntheticEvent } from 'react';
import { apiFetch } from '@/lib/api-client';
import { orgAdminMessage } from './messages';
import { DirectorySync } from './directory-sync';
import type { GroupView, SsoConnection } from './org-settings-api';

const INPUT = 'rounded-md border border-border bg-surface px-2 py-1 text-sm text-text';

interface Draft {
  protocol: 'oidc' | 'saml';
  name: string;
  domains: string;
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret: string;
  samlEntryPoint: string;
  samlIdpCert: string;
  jit: boolean;
  defaultOrgRole: 'member' | 'guest';
  enforced: boolean;
  groupsClaim: string;
}

const EMPTY: Draft = {
  protocol: 'oidc',
  name: '',
  domains: '',
  oidcIssuer: '',
  oidcClientId: '',
  oidcClientSecret: '',
  samlEntryPoint: '',
  samlIdpCert: '',
  jit: false,
  defaultOrgRole: 'member',
  enforced: false,
  groupsClaim: '',
};

const draftOf = (c: SsoConnection): Draft => ({
  protocol: c.protocol,
  name: c.name,
  domains: c.domains.join(', '),
  oidcIssuer: c.oidcIssuer ?? '',
  oidcClientId: c.oidcClientId ?? '',
  oidcClientSecret: '',
  samlEntryPoint: c.samlEntryPoint ?? '',
  samlIdpCert: c.samlIdpCert ?? '',
  jit: c.jit,
  defaultOrgRole: c.defaultOrgRole === 'guest' ? 'guest' : 'member',
  enforced: c.enforced,
  groupsClaim: c.groupsClaim ?? '',
});

/** The body the api takes; a blank secret on an edit keeps the stored one. */
function bodyOf(d: Draft) {
  const shared = {
    protocol: d.protocol,
    name: d.name.trim(),
    domains: d.domains
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter(Boolean),
    jit: d.jit,
    defaultOrgRole: d.defaultOrgRole,
    enforced: d.enforced,
    groupsClaim: d.groupsClaim.trim(),
  };
  return d.protocol === 'oidc'
    ? {
        ...shared,
        oidcIssuer: d.oidcIssuer.trim(),
        oidcClientId: d.oidcClientId.trim(),
        ...(d.oidcClientSecret === '' ? {} : { oidcClientSecret: d.oidcClientSecret }),
      }
    : { ...shared, samlEntryPoint: d.samlEntryPoint.trim(), samlIdpCert: d.samlIdpCert.trim() };
}

function Field({
  label,
  children,
  hint,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm text-text">
      <span className="font-medium">{label}</span>
      {children}
      {hint !== undefined && <span className="text-xs text-text-muted">{hint}</span>}
    </label>
  );
}

function ConnectionForm({
  base,
  editing,
  onDone,
}: {
  readonly base: string;
  readonly editing: SsoConnection | null;
  readonly onDone: (text: string) => void;
}) {
  const [d, setD] = useState<Draft>(editing === null ? EMPTY : draftOf(editing));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setD((prev) => ({ ...prev, [key]: value }));
  };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiFetch(editing === null ? base : `${base}/${editing.id}`, {
        method: editing === null ? 'POST' : 'PATCH',
        body: bodyOf(d),
      });
      onDone(editing === null ? `Added ${d.name}.` : `Saved ${d.name}.`);
    } catch (caught) {
      setError(orgAdminMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-3 rounded-md border border-border p-4"
      aria-label={editing === null ? 'New connection' : `Edit ${editing.name}`}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Protocol">
          <select
            className={INPUT}
            value={d.protocol}
            disabled={editing !== null}
            onChange={(e) => {
              set('protocol', e.target.value as Draft['protocol']);
            }}
          >
            <option value="oidc">OpenID Connect</option>
            <option value="saml">SAML 2.0</option>
          </select>
        </Field>
        <Field label="Name" hint="On the sign-in button, e.g. Acme Okta">
          <input
            className={INPUT}
            value={d.name}
            onChange={(e) => {
              set('name', e.target.value);
            }}
          />
        </Field>
      </div>
      <Field label="Email domains" hint="Comma-separated, e.g. acme.com, acme.co.uk">
        <input
          className={INPUT}
          value={d.domains}
          onChange={(e) => {
            set('domains', e.target.value);
          }}
        />
      </Field>
      {d.protocol === 'oidc' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Issuer URL">
            <input
              className={INPUT}
              value={d.oidcIssuer}
              placeholder="https://idp.example.com/realms/acme"
              onChange={(e) => {
                set('oidcIssuer', e.target.value);
              }}
            />
          </Field>
          <Field label="Client ID">
            <input
              className={INPUT}
              value={d.oidcClientId}
              onChange={(e) => {
                set('oidcClientId', e.target.value);
              }}
            />
          </Field>
          <Field
            label="Client secret"
            hint={
              editing?.hasClientSecret === true ? 'Leave blank to keep the saved one' : undefined
            }
          >
            <input
              className={INPUT}
              type="password"
              autoComplete="off"
              value={d.oidcClientSecret}
              onChange={(e) => {
                set('oidcClientSecret', e.target.value);
              }}
            />
          </Field>
        </div>
      ) : (
        <>
          <Field label="IdP sign-in URL">
            <input
              className={INPUT}
              value={d.samlEntryPoint}
              onChange={(e) => {
                set('samlEntryPoint', e.target.value);
              }}
            />
          </Field>
          <Field label="IdP signing certificate" hint="PEM, or the base64 body">
            <textarea
              className={`${INPUT} font-mono text-xs`}
              rows={4}
              value={d.samlIdpCert}
              onChange={(e) => {
                set('samlIdpCert', e.target.value);
              }}
            />
          </Field>
        </>
      )}
      <label className="flex items-center gap-2 text-sm text-text">
        <input
          type="checkbox"
          checked={d.jit}
          onChange={(e) => {
            set('jit', e.target.checked);
          }}
        />
        Create an account on first sign-in, joining as
        <select
          aria-label="Role for new members"
          className={INPUT}
          value={d.defaultOrgRole}
          onChange={(e) => {
            set('defaultOrgRole', e.target.value as Draft['defaultOrgRole']);
          }}
        >
          <option value="member">member</option>
          <option value="guest">guest</option>
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm text-text">
        <input
          type="checkbox"
          checked={d.enforced}
          onChange={(e) => {
            set('enforced', e.target.checked);
          }}
        />
        Require single sign-on for members with these domains (owners can still sign in the usual
        way)
      </label>
      <Field
        label="Groups claim"
        hint="The claim or attribute listing a person's groups, e.g. groups. Leave blank to skip group sync at sign-in."
      >
        <input
          className={INPUT}
          value={d.groupsClaim}
          onChange={(e) => {
            set('groupsClaim', e.target.value);
          }}
        />
      </Field>
      {error !== null && (
        <p role="alert" className="text-sm text-danger-text">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {editing === null ? 'Add connection' : 'Save'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            onDone('');
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function SpValues({ sp }: { readonly sp: SsoConnection['sp'] }) {
  const rows =
    'redirectUri' in sp
      ? [['Redirect URI', sp.redirectUri]]
      : [
          ['Entity ID', sp.entityId],
          ['ACS URL', sp.acsUrl],
          ['Metadata', sp.metadataUrl],
        ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-text-muted">{k}</dt>
          <dd className="font-mono break-all text-text">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Roadmap 14 §1 — owners add, edit and remove the org's identity providers. */
export function SsoSettings({
  orgSlug,
  connections,
  groups,
}: {
  readonly orgSlug: string;
  readonly connections: readonly SsoConnection[];
  readonly groups: readonly GroupView[];
}) {
  const router = useRouter();
  const base = `/organizations/${encodeURIComponent(orgSlug)}/sso-connections`;
  const [editing, setEditing] = useState<SsoConnection | 'new' | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);

  const done = (text: string) => {
    setEditing(null);
    if (text !== '') setNotice({ error: false, text });
    router.refresh();
  };

  const remove = async (c: SsoConnection) => {
    setNotice(null);
    try {
      await apiFetch(`${base}/${c.id}`, { method: 'DELETE' });
      done(`Removed ${c.name}.`);
    } catch (caught) {
      setNotice({ error: true, text: orgAdminMessage(caught) });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {notice !== null && (
        <p
          role={notice.error ? 'alert' : 'status'}
          className={notice.error ? 'text-sm text-danger-text' : 'text-sm text-text-muted'}
        >
          {notice.text}
        </p>
      )}
      {connections.length === 0 && editing === null && (
        <p className="text-sm text-text-muted">No single sign-on yet.</p>
      )}
      <ul className="flex flex-col gap-3">
        {connections.map((c) =>
          editing !== null && editing !== 'new' && editing.id === c.id ? (
            <li key={c.id}>
              <ConnectionForm base={base} editing={c} onDone={done} />
            </li>
          ) : (
            <li key={c.id} className="flex flex-col gap-2 rounded-md border border-border p-4">
              <div className="flex items-center gap-2">
                <span className="font-medium text-text">{c.name}</span>
                <span className="text-xs text-text-muted uppercase">{c.protocol}</span>
                {c.enforced && (
                  <span className="rounded bg-surface-sunken px-1.5 text-xs text-text">
                    required
                  </span>
                )}
                <span className="ml-auto flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(c);
                    }}
                  >
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void remove(c)}>
                    Remove
                  </Button>
                </span>
              </div>
              <p className="text-xs text-text-muted">
                {c.domains.join(', ')}
                {c.jit && ` · new people join as ${c.defaultOrgRole}`}
              </p>
              <SpValues sp={c.sp} />
              <DirectorySync base={`${base}/${c.id}`} connection={c} groups={groups} />
            </li>
          ),
        )}
      </ul>
      {editing === 'new' ? (
        <ConnectionForm base={base} editing={null} onDone={done} />
      ) : (
        <Button
          className="self-start"
          onClick={() => {
            setEditing('new');
          }}
        >
          Add a connection
        </Button>
      )}
    </div>
  );
}
