'use client';

import { useState } from 'react';
import { visibleFields, type EngineStaticFacet } from '@schemaloom/engine-sdk/ui';

/** Phase 6 §5 — the engine's own form, so no engine is named here. */
export type ConnectionField = EngineStaticFacet['capabilities']['connectionFields'][number];

/** Every input's text, keyed by field id. Lists are comma-separated. */
export type ConnectionDraft = Readonly<Record<string, string>>;

export const hasConnectionForm = (fields: readonly ConnectionField[] | undefined): boolean =>
  (fields?.length ?? 0) > 0;

export function initialDraft(fields: readonly ConnectionField[]): ConnectionDraft {
  return Object.fromEntries(
    fields.map((f) => [f.id, f.default === undefined ? '' : String(f.default)]),
  );
}

/** The request body's `connection`: numbers as numbers, lists as arrays, empties and hidden
 *  fields (§10.1) left out so the api applies the engine's defaults. */
export function connectionPayload(
  fields: readonly ConnectionField[],
  draft: ConnectionDraft,
): Record<string, string | number | string[]> {
  const out: Record<string, string | number | string[]> = {};
  for (const field of visibleFields(fields, draft)) {
    const value = (draft[field.id] ?? '').trim();
    if (value === '') continue;
    out[field.id] =
      field.kind === 'number'
        ? Number(value)
        : field.kind === 'list'
          ? value
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s !== '')
          : field.kind === 'secret'
            ? (draft[field.id] ?? '')
            : value;
  }
  return out;
}

/**
 * Q7 — "paste a URL" fills the fields in the browser; the server only ever sees fields. Maps
 * the URL's parts onto the conventional ids (`host`, `port`, `database`, `user`, `password`,
 * and any query parameter that names a field, like `sslmode`), skipping ids the engine
 * doesn't declare.
 */
export function draftFromUrl(
  fields: readonly ConnectionField[],
  draft: ConnectionDraft,
  text: string,
): ConnectionDraft | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  const ids = new Set(fields.map((f) => f.id));
  const next: Record<string, string> = { ...draft };
  const set = (id: string, value: string) => {
    if (ids.has(id) && value !== '') next[id] = value;
  };
  set('host', url.hostname.replace(/^\[|\]$/g, ''));
  set('port', url.port);
  set('database', decodeURIComponent(url.pathname.replace(/^\//, '')));
  set('user', decodeURIComponent(url.username));
  set('password', decodeURIComponent(url.password));
  for (const [key, value] of url.searchParams) set(key, value);
  return next;
}

const inputClass = 'rounded-md border border-border bg-surface px-3 py-2 text-sm text-text';

/** Visible fields in order, grouped by `section`; unsectioned fields come first. */
function sectionsOf(
  fields: readonly ConnectionField[],
): readonly { readonly title: string | null; readonly fields: readonly ConnectionField[] }[] {
  const groups = new Map<string | null, ConnectionField[]>([[null, []]]);
  for (const field of fields) {
    const key = field.section ?? null;
    groups.set(key, [...(groups.get(key) ?? []), field]);
  }
  return [...groups].map(([title, list]) => ({ title, fields: list }));
}

function FieldInput({
  field,
  value,
  disabled,
  saved,
  onChange,
}: {
  readonly field: ConnectionField;
  readonly value: string;
  readonly disabled: boolean;
  /** 6c — a secret the project's saved connection already holds */
  readonly saved: boolean;
  readonly onChange: (value: string) => void;
}) {
  const required = field.required && !saved;
  if (field.kind === 'select') {
    return (
      <select
        value={value}
        disabled={disabled}
        required={field.required}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        className={inputClass}
      >
        {(field.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (field.kind === 'file') {
    // §10.1 — PEM text, pasted or read from a file in the browser; only the text is sent.
    return (
      <>
        <textarea
          value={value}
          disabled={disabled}
          required={required}
          rows={3}
          spellCheck={false}
          autoComplete="off"
          placeholder={saved ? 'Saved: leave blank to keep' : '-----BEGIN …'}
          onChange={(e) => {
            onChange(e.target.value);
          }}
          className={`${inputClass} font-mono text-xs`}
        />
        <input
          type="file"
          disabled={disabled}
          aria-label={`${field.label} file`}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file !== undefined) void file.text().then(onChange);
          }}
          className="text-xs text-text-muted"
        />
      </>
    );
  }
  return (
    <input
      value={value}
      disabled={disabled}
      required={required}
      type={field.kind === 'secret' ? 'password' : field.kind === 'number' ? 'number' : 'text'}
      autoComplete={field.kind === 'secret' ? 'new-password' : 'off'}
      spellCheck={false}
      placeholder={
        saved ? 'Saved: leave blank to keep' : field.kind === 'list' ? 'comma-separated' : undefined
      }
      onChange={(e) => {
        onChange(e.target.value);
      }}
      className={inputClass}
    />
  );
}

export function ConnectionForm({
  fields,
  draft,
  onChange,
  disabled = false,
  savedSecrets,
}: {
  readonly fields: readonly ConnectionField[];
  readonly draft: ConnectionDraft;
  readonly onChange: (draft: ConnectionDraft) => void;
  readonly disabled?: boolean;
  /** 6c — ids of secrets the saved connection holds; their inputs may stay blank */
  readonly savedSecrets?: ReadonlySet<string> | undefined;
}) {
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState(false);
  const shown = visibleFields(fields, draft);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-text-muted">
        Use a read-only role. SchemaLoom only reads the schema, never your data.
      </p>
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        Paste a connection URL to fill the fields
        <input
          value={url}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          placeholder="postgres://user@host:5432/database"
          onChange={(e) => {
            setUrl(e.target.value);
            setUrlError(false);
          }}
          onBlur={() => {
            if (url.trim() === '') return;
            const next = draftFromUrl(fields, draft, url);
            if (next === null) {
              setUrlError(true);
              return;
            }
            onChange(next);
            // The URL can hold a password; don't leave it sitting in a plain text box.
            setUrl('');
          }}
          className={`${inputClass} font-mono text-xs`}
        />
        {urlError && <span className="text-danger-text">That is not a URL.</span>}
      </label>
      {sectionsOf(shown).map(({ title, fields: group }) => (
        <fieldset key={title ?? ''} className="flex flex-col gap-2">
          {title !== null && (
            <legend className="mb-1 text-xs font-medium tracking-wide text-text-muted uppercase">
              {title}
            </legend>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {group.map((field) => (
              <label
                key={field.id}
                className={`flex flex-col gap-1 text-sm text-text ${
                  field.kind === 'file' ? 'sm:col-span-2' : ''
                }`}
              >
                {field.label}
                <FieldInput
                  field={field}
                  value={draft[field.id] ?? ''}
                  disabled={disabled}
                  saved={savedSecrets?.has(field.id) ?? false}
                  onChange={(next) => {
                    onChange({ ...draft, [field.id]: next });
                  }}
                />
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

/** §10.3 — shown after a read through SSH, so the user can check the key and pin it. */
export function SshHostKeyNote({ hostKey }: { readonly hostKey: string | undefined }) {
  if (hostKey === undefined) return null;
  return (
    <p className="text-xs text-text-muted">
      Connected through SSH. The server identified itself as{' '}
      <code className="font-mono break-all">{hostKey}</code>. Check it with the server’s
      administrator, then paste it into “Host key fingerprint” next time so a different key is
      refused.
    </p>
  );
}
