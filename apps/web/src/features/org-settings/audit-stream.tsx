'use client';

import { Button } from '@schemaloom/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type SyntheticEvent } from 'react';
import { z } from 'zod';
import { apiFetch } from '@/lib/api-client';
import { relativeTime } from '@/features/projects/relative-time';
import { orgAdminMessage } from './messages';

/** `GET /organizations/:slug/audit-stream` — `apps/api/src/audit-stream/audit-stream.service.ts`. */
const StreamSchema = z.object({
  url: z.string(),
  format: z.string(),
  authHeaderName: z.string().nullable(),
  hasAuthHeader: z.boolean(),
  paused: z.boolean(),
  status: z.string(),
  lastError: z.string().nullable(),
  lastDeliveredAt: z.string().nullable(),
  failingSince: z.string().nullable(),
  nextAttemptAt: z.string().nullable(),
  createdAt: z.string(),
});
type Stream = z.infer<typeof StreamSchema>;
const ResponseSchema = z.object({ stream: StreamSchema.nullable() });

const FORMATS = [
  { id: 'json', label: 'JSON (any HTTPS endpoint)' },
  { id: 'splunk_hec', label: 'Splunk HTTP Event Collector' },
  { id: 'datadog', label: 'Datadog logs' },
] as const;

const INPUT = 'h-8 rounded-md border border-border bg-surface px-2 text-sm text-text';

function statusLine(s: Stream): string {
  if (s.paused) return 'Paused. Events wait here until you resume.';
  if (s.status === 'failing') {
    const since = s.failingSince === null ? '' : new Date(s.failingSince).toLocaleString();
    return `Retrying since ${since}: ${s.lastError ?? 'unknown error'}. Rows older than 24 months are deleted by retention and never reach the endpoint.`;
  }
  if (s.lastDeliveredAt === null)
    return 'Delivering. Nothing sent yet; events go out about 2 minutes after they happen.';
  return `Delivering, last batch ${relativeTime(s.lastDeliveredAt)}.`;
}

/**
 * Roadmap 14d (`docs/phase14/AUDIT-STREAMING.md` §1) — owners stream the org's audit log to
 * their SIEM. The signing secret is shown once, after the first save.
 */
export function AuditStream({ orgSlug }: { readonly orgSlug: string }) {
  const base = `/organizations/${encodeURIComponent(orgSlug)}/audit-stream`;
  const queryKey = ['audit-stream', orgSlug];
  const queryClient = useQueryClient();
  const current = useQuery({
    queryKey,
    queryFn: async () => ResponseSchema.parse(await apiFetch<unknown>(base)).stream,
  });
  const stream = current.data ?? null;

  const [url, setUrl] = useState('');
  const [format, setFormat] = useState<string>('json');
  const [headerName, setHeaderName] = useState('');
  const [headerValue, setHeaderValue] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (stream === null) return;
    setUrl(stream.url);
    setFormat(stream.format);
    setHeaderName(stream.authHeaderName ?? '');
  }, [stream]);

  const run = async (write: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await write();
      await queryClient.invalidateQueries({ queryKey });
    } catch (caught) {
      setMessage({ text: orgAdminMessage(caught), error: true });
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    void run(async () => {
      const saved = await apiFetch<{ signingSecret?: string }>(base, {
        method: 'PUT',
        body: {
          url: url.trim(),
          format,
          authHeaderName: headerName.trim(),
          ...(headerValue === '' ? {} : { authHeaderValue: headerValue }),
          paused: stream?.paused ?? false,
        },
      });
      setHeaderValue('');
      if (saved.signingSecret !== undefined) setSecret(saved.signingSecret);
    });
  };

  /** Pause and Resume keep the saved settings (and the cursor), whatever the form holds. */
  const setPaused = (s: Stream) =>
    run(async () => {
      await apiFetch(base, {
        method: 'PUT',
        body: {
          url: s.url,
          format: s.format,
          authHeaderName: s.authHeaderName ?? '',
          paused: !s.paused,
        },
      });
    });

  const sendTest = () =>
    run(async () => {
      const result = await apiFetch<{ ok: boolean; error?: string }>(`${base}/test`, {
        method: 'POST',
      });
      setMessage(
        result.ok
          ? { text: 'The endpoint accepted the test event.', error: false }
          : { text: `The test event failed: ${result.error ?? 'unknown error'}.`, error: true },
      );
    });

  const remove = () => {
    if (!window.confirm('Stop streaming and forget where it got to? Deleting can’t be undone.'))
      return;
    setSecret(null);
    void run(async () => {
      await apiFetch(base, { method: 'DELETE' });
      setUrl('');
      setFormat('json');
      setHeaderName('');
    });
  };

  return (
    <section
      aria-labelledby="audit-stream"
      className="mb-8 flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <div>
        <h2 id="audit-stream" className="text-sm font-semibold text-text">
          Stream to a SIEM
        </h2>
        <p className="mt-1 text-xs text-text-muted">
          Send every event in this log to Splunk, Datadog or any HTTPS endpoint as it happens. Each
          request is signed: <span className="font-mono">X-SchemaLoom-Signature</span> is{' '}
          <span className="font-mono">sha256=</span> and the HMAC-SHA256 of the body under the
          signing secret. Every event carries its id, so you can drop repeats.
        </p>
      </div>

      {current.isPending ? (
        <p className="text-sm text-text-subtle">Loading…</p>
      ) : current.isError ? (
        <p role="alert" className="text-sm text-danger-text">
          Could not load the stream settings.
        </p>
      ) : (
        <>
          {stream !== null && (
            <p
              role="status"
              className={`text-sm ${stream.status === 'failing' && !stream.paused ? 'text-danger-text' : 'text-text'}`}
            >
              {statusLine(stream)}
            </p>
          )}
          {secret !== null && (
            <label className="flex flex-col gap-1 text-xs text-text">
              <span>Signing secret. Copy it now; it is not shown again.</span>
              <input
                readOnly
                aria-label="Signing secret"
                className={`${INPUT} font-mono`}
                value={secret}
                onFocus={(e) => {
                  e.target.select();
                }}
              />
            </label>
          )}
          <form className="flex flex-col gap-2" onSubmit={onSubmit}>
            <div className="flex flex-wrap gap-2">
              <input
                required
                type="url"
                pattern="https://.*"
                maxLength={2000}
                aria-label="Endpoint URL"
                placeholder="https://http-inputs.example.splunkcloud.com/services/collector/event"
                className={`${INPUT} min-w-0 flex-[2_1_20rem]`}
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                }}
              />
              <select
                aria-label="Format"
                className={`${INPUT} flex-[1_1_12rem]`}
                value={format}
                onChange={(e) => {
                  setFormat(e.target.value);
                }}
              >
                {FORMATS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                maxLength={100}
                aria-label="Auth header name"
                placeholder="Auth header, e.g. Authorization (optional)"
                className={`${INPUT} min-w-0 flex-[1_1_12rem]`}
                value={headerName}
                onChange={(e) => {
                  setHeaderName(e.target.value);
                }}
              />
              <input
                type="password"
                maxLength={4000}
                aria-label="Auth header value"
                autoComplete="off"
                placeholder={
                  stream?.hasAuthHeader === true ? 'Value saved; type to replace' : 'Value'
                }
                className={`${INPUT} min-w-0 flex-[2_1_16rem]`}
                value={headerValue}
                onChange={(e) => {
                  setHeaderValue(e.target.value);
                }}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={busy}>
                {stream === null ? 'Start streaming' : 'Save'}
              </Button>
              {stream !== null && (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void sendTest()}
                  >
                    Send test event
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void setPaused(stream)}
                  >
                    {stream.paused ? 'Resume' : 'Pause'}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={remove}>
                    Delete
                  </Button>
                </>
              )}
            </div>
          </form>
          {message !== null && (
            <p
              role={message.error ? 'alert' : 'status'}
              className={`text-sm ${message.error ? 'text-danger-text' : 'text-text'}`}
            >
              {message.text}
            </p>
          )}
        </>
      )}
    </section>
  );
}
