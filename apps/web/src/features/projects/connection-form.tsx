'use client';

import { useState } from 'react';
import type { EngineStaticFacet } from '@schemaloom/engine-sdk/ui';

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

/** The request body's `connection`: numbers as numbers, lists as arrays, empties left out
 *  so the api applies the engine's defaults. */
export function connectionPayload(
  fields: readonly ConnectionField[],
  draft: ConnectionDraft,
): Record<string, string | number | string[]> {
  const out: Record<string, string | number | string[]> = {};
  for (const field of fields) {
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

export function ConnectionForm({
  fields,
  draft,
  onChange,
  disabled = false,
}: {
  readonly fields: readonly ConnectionField[];
  readonly draft: ConnectionDraft;
  readonly onChange: (draft: ConnectionDraft) => void;
  readonly disabled?: boolean;
}) {
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-text-muted">
        Use a read-only role. SchemaLoom only reads the schema, never your data, and does not keep
        these details.
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
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((field) => {
          const value = draft[field.id] ?? '';
          const set = (next: string) => {
            onChange({ ...draft, [field.id]: next });
          };
          return (
            <label key={field.id} className="flex flex-col gap-1 text-sm text-text">
              {field.label}
              {field.kind === 'select' ? (
                <select
                  value={value}
                  disabled={disabled}
                  required={field.required}
                  onChange={(e) => {
                    set(e.target.value);
                  }}
                  className={inputClass}
                >
                  {(field.options ?? []).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={value}
                  disabled={disabled}
                  required={field.required}
                  type={
                    field.kind === 'secret'
                      ? 'password'
                      : field.kind === 'number'
                        ? 'number'
                        : 'text'
                  }
                  autoComplete={field.kind === 'secret' ? 'new-password' : 'off'}
                  spellCheck={false}
                  placeholder={field.kind === 'list' ? 'comma-separated' : undefined}
                  onChange={(e) => {
                    set(e.target.value);
                  }}
                  className={inputClass}
                />
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}
