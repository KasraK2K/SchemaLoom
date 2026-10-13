'use client';

import { Button } from '@schemaloom/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { orgAdminMessage } from '@/features/org-settings/messages';
import {
  capabilityHints,
  deleteIntegration,
  listIntegrations,
  providerLabel,
  testIntegration,
  type Integration,
  type IntegrationBase,
} from './ai-integrations-api';
import { IntegrationForm } from './integration-form';
import { Message, useRun } from './use-run';

const DOT = { ok: 'bg-success', failing: 'bg-danger', unchecked: 'bg-text-subtle' } as const;
const STATUS = { ok: 'Working', failing: 'Failing', unchecked: 'Not tested' } as const;

/**
 * Roadmap 24 §5.1 — the integrations of one owner (an org, or the signed-in user). `expand`
 * adds an "Access" panel under a row, which the org page fills with the grants editor.
 */
export function IntegrationList({
  base,
  expand,
}: {
  readonly base: IntegrationBase;
  readonly expand?: (integration: Integration) => ReactNode;
}) {
  const headingId = useId();
  const queryKey = ['ai-integrations', base];
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey, queryFn: () => listIntegrations(base) });
  const refresh = () => queryClient.invalidateQueries({ queryKey });
  const { busy, message, setMessage, run } = useRun(refresh);
  // 'new', the id of the integration being edited, or null.
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const done = () => {
    setEditing(null);
  };

  return (
    <section
      aria-labelledby={headingId}
      className="mb-8 flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id={headingId} className="text-sm font-semibold text-text">
          Integrations
        </h2>
        <Button
          type="button"
          size="sm"
          disabled={editing === 'new'}
          onClick={() => {
            setEditing('new');
          }}
        >
          Add integration
        </Button>
      </div>

      {list.isPending ? (
        <p className="text-sm text-text-subtle">Loading…</p>
      ) : list.isError ? (
        <p role="alert" className="text-sm text-danger-text">
          {orgAdminMessage(list.error)}
        </p>
      ) : (
        <>
          {list.data.length === 0 && editing !== 'new' && (
            <p className="text-sm text-text-muted">No integrations yet.</p>
          )}
          <ul className="flex flex-col divide-y divide-border">
            {list.data.map((i) => {
              const server = i.source === 'server';
              return (
                <li key={i.id} className="flex flex-col gap-2 py-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-sm font-medium text-text">{i.name}</span>
                    <span className="text-xs text-text-muted">{providerLabel(i.provider)}</span>
                    <span className="flex items-center gap-1 text-xs text-text-muted">
                      <span aria-hidden className={`size-2 rounded-full ${DOT[i.status]}`} />
                      {STATUS[i.status]}
                    </span>
                    <span className="text-xs text-text-muted">
                      {String(i.models.length)} {i.models.length === 1 ? 'model' : 'models'}
                    </span>
                    <span className="text-xs text-text-subtle">
                      {server
                        ? 'Server · full features'
                        : capabilityHints(i.capabilities).join(' · ')}
                    </span>
                  </div>
                  {i.status === 'failing' && i.lastError !== null && (
                    <p className="text-xs text-danger-text">{i.lastError}</p>
                  )}
                  {editing !== i.id && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          void run(async () => {
                            const r = await testIntegration(base, i.id);
                            setMessage(
                              r.status === 'ok'
                                ? {
                                    text: `${i.name}: connected, ${String(r.fetchedModels.length)} models found.`,
                                    error: false,
                                  }
                                : {
                                    text: `${i.name}: ${r.lastError ?? 'the test failed'}.`,
                                    error: true,
                                  },
                            );
                          });
                        }}
                      >
                        Test
                      </Button>
                      {!server && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditing(i.id);
                          }}
                        >
                          Edit
                        </Button>
                      )}
                      {expand !== undefined && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-expanded={open === i.id}
                          onClick={() => {
                            setOpen(open === i.id ? null : i.id);
                          }}
                        >
                          Access
                        </Button>
                      )}
                      {!server &&
                        (confirming === i.id ? (
                          <>
                            <Button
                              type="button"
                              size="sm"
                              variant="danger"
                              disabled={busy}
                              onClick={() => {
                                setConfirming(null);
                                void run(() => deleteIntegration(base, i.id));
                              }}
                            >
                              Delete
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setConfirming(null);
                              }}
                            >
                              Cancel
                            </Button>
                            <span className="self-center text-xs text-text-muted">
                              Choices that use it stop working.
                            </span>
                          </>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setConfirming(i.id);
                            }}
                          >
                            Delete
                          </Button>
                        ))}
                    </div>
                  )}
                  {editing === i.id && (
                    <IntegrationForm base={base} existing={i} onSaved={refresh} onDone={done} />
                  )}
                  {expand !== undefined && open === i.id && expand(i)}
                </li>
              );
            })}
          </ul>
          {editing === 'new' && (
            <IntegrationForm base={base} existing={null} onSaved={refresh} onDone={done} />
          )}
        </>
      )}
      <Message message={message} />
    </section>
  );
}
