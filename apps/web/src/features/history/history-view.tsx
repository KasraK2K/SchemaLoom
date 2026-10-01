'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  cn,
} from '@schemaloom/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useEngine } from '@/engines';
import { irQueryOptions } from '@/features/canvas/ir-query';
import { projectShellQueryOptions } from '@/features/change-requests/change-requests-api';
import { EngineGate } from '@/features/project/engine-gate';
import { SshHostKeyNote, hasConnectionForm } from '@/features/projects/connection-form';
import { relativeTime } from '@/features/projects/relative-time';
import { ConnectionSection, useConnectionChoice } from '@/features/projects/saved-connection';
import { ApiError } from '@/lib/api-client';
import {
  createSnapshot,
  deleteSnapshot,
  diffQueryOptions,
  entryName,
  groupByEntity,
  isCosmeticOnly,
  migrationQueryOptions,
  restoreSnapshot,
  snapshotsKey,
  snapshotsQueryOptions,
  summarize,
  type DiffEntry,
  type DiffProperty,
  type HistoryDiff,
  checkDrift,
  type DriftView,
  type MigrationStep,
  type MigrationView,
  type Snapshot,
} from './history-api';

const errorText = (caught: unknown): string =>
  caught instanceof ApiError ? caught.message : 'Something went wrong. Try again.';

/**
 * Phase 4 §1.2 — the project's history: snapshot list on the left, diff on the right.
 *
 * The web does not know the caller's atoms, so the tab is always shown and a caller
 * without `history:view` gets the API's refusal rendered as "not available" here.
 */
export function HistoryView({
  orgSlug,
  projectId,
}: {
  readonly orgSlug: string;
  readonly projectId: string;
}) {
  const list = useQuery(snapshotsQueryOptions(projectId));
  const [selected, setSelected] = useState<string | null>(null);
  const [compareTo, setCompareTo] = useState<string | null>(null);

  if (list.error !== null) {
    const status = list.error instanceof ApiError ? list.error.status : 0;
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div>
          <h1 className="text-sm font-medium text-text">History is not available</h1>
          <p className="mt-1 text-xs text-text-muted">
            {status === 403 || status === 404
              ? 'You do not have access to this project’s history.'
              : errorText(list.error)}
          </p>
        </div>
      </div>
    );
  }

  const snapshots = list.data ?? [];
  const current = snapshots.find((s) => s.id === selected) ?? snapshots[0] ?? null;

  return (
    <div className="flex h-full min-h-0">
      <section
        aria-label="Snapshots"
        className="flex w-80 shrink-0 flex-col gap-3 overflow-auto border-r border-border p-3"
      >
        <TakeSnapshot projectId={projectId} />
        <EngineGate projectId={projectId} fallback={null}>
          <DriftCheck projectId={projectId} />
        </EngineGate>
        {list.isPending ? (
          <p className="text-xs text-text-subtle">Loading…</p>
        ) : snapshots.length === 0 ? (
          <p className="text-xs text-text-muted">No snapshots yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {snapshots.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  aria-pressed={current?.id === s.id}
                  onClick={() => {
                    setSelected(s.id);
                    if (compareTo === s.id) setCompareTo(null);
                  }}
                  className={cn(
                    'flex w-full flex-col rounded px-2 py-1.5 text-left hover:bg-surface-hover',
                    current?.id === s.id && 'bg-surface-sunken',
                  )}
                >
                  <span className="flex items-center gap-2 text-sm text-text">
                    <span className="truncate">{s.name}</span>
                    <span className="rounded bg-surface-sunken px-1 text-[10px] text-text-muted uppercase">
                      {s.kind}
                    </span>
                  </span>
                  <span className="text-xs text-text-subtle">{relativeTime(s.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Diff" className="min-w-0 flex-1 overflow-auto p-4">
        {current === null ? (
          <p className="text-sm text-text-muted">Take a snapshot to start a history.</p>
        ) : (
          <DiffPane
            key={`${current.id}:${compareTo ?? 'live'}`}
            orgSlug={orgSlug}
            projectId={projectId}
            snapshot={current}
            snapshots={snapshots}
            compareTo={compareTo}
            onCompareTo={setCompareTo}
            onDeleted={() => {
              setSelected(null);
            }}
          />
        )}
      </section>
    </div>
  );
}

/**
 * Phase 6 §6 — "Compare with a database": read a live database's schema on the server and
 * show how it differs from the design, plus the SQL that brings the database in line.
 * Nothing is written, to the project or to the database. Needs the full view, like
 * migrations; the API says so otherwise.
 */
function DriftCheck({ projectId }: { readonly projectId: string }) {
  const fields = useEngine().capabilities.connectionFields;
  const ir = useQuery(irQueryOptions(projectId));
  const [open, setOpen] = useState(false);
  const choice = useConnectionChoice(projectId, fields);
  const [allowDestructive, setAllowDestructive] = useState(false);
  const [result, setResult] = useState<DriftView | null>(null);
  const compare = useMutation({
    mutationFn: async () =>
      checkDrift(projectId, (await choice.resolve()).source, allowDestructive),
    onSuccess: setResult,
  });
  // 6d — a drift notification links to `?compare=saved`: open Compare and run it once.
  const searchParams = useSearchParams();
  const autoRun = useRef(searchParams.get('compare') === 'saved');
  useEffect(() => {
    if (!autoRun.current) return;
    setOpen(true);
    if (choice.saved === undefined) return;
    autoRun.current = false;
    if (choice.saved !== null) compare.mutate();
  }, [choice.saved, compare]);

  if (!hasConnectionForm(fields)) return null;
  const entityName = (id: string): string | null => ir.data?.objects.entity[id]?.name ?? null;

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setOpen(true);
        }}
      >
        Compare with a database
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (compare.isPending) return;
          setOpen(next);
          if (!next) {
            setResult(null);
            choice.reset();
            compare.reset();
          }
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-auto">
          <DialogTitle>Compare with a database</DialogTitle>
          <DialogDescription>
            {result === null
              ? 'Reads the database’s schema and shows how it differs from this design. Nothing is written.'
              : `Database (server ${result.serverVersion}) → this design. The SQL below brings the database in line with the design.`}
          </DialogDescription>
          {result === null ? (
            <form
              className="mt-4 flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                compare.mutate();
              }}
            >
              <ConnectionSection choice={choice} fields={fields} disabled={compare.isPending} />
              <label className="flex items-center gap-1 text-xs text-text-muted">
                <input
                  type="checkbox"
                  checked={allowDestructive}
                  onChange={(e) => {
                    setAllowDestructive(e.target.checked);
                  }}
                />
                Include destructive steps in the SQL
              </label>
              {compare.error !== null && (
                <p role="alert" className="text-xs text-danger-text">
                  {errorText(compare.error)}
                </p>
              )}
              <DialogFooter>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={compare.isPending || choice.saved === undefined}
                >
                  {compare.isPending ? 'Reading…' : 'Compare'}
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <div className="mt-4 flex flex-col gap-4">
              <SshHostKeyNote hostKey={result.sshHostKey} />
              <DiffBody
                diff={result.diff}
                hideCosmetic
                entityName={entityName}
                canvasHref={() => null}
              />
              <h2 className="text-sm font-medium text-text">SQL for the database</h2>
              <PlanBody
                plan={result.migration}
                fileName="drift"
                allowDestructive={allowDestructive}
              />
              <DialogFooter>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setResult(null);
                  }}
                >
                  Compare again
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function TakeSnapshot({ projectId }: { readonly projectId: string }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const create = useMutation({
    mutationFn: () =>
      createSnapshot(projectId, {
        name: name.trim(),
        ...(note.trim() === '' ? {} : { description: note.trim() }),
      }),
    onSuccess: async () => {
      setName('');
      setNote('');
      await queryClient.invalidateQueries({ queryKey: snapshotsKey(projectId) });
    },
  });
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <input
        aria-label="Snapshot name"
        placeholder="Snapshot name"
        value={name}
        maxLength={200}
        onChange={(e) => {
          setName(e.target.value);
        }}
        className="h-8 rounded border border-border bg-surface px-2 text-xs text-text"
      />
      <input
        aria-label="Note (optional)"
        placeholder="Note (optional)"
        value={note}
        maxLength={2000}
        onChange={(e) => {
          setNote(e.target.value);
        }}
        className="h-8 rounded border border-border bg-surface px-2 text-xs text-text"
      />
      <Button type="submit" size="sm" disabled={create.isPending || name.trim() === ''}>
        {create.isPending ? 'Saving…' : 'Take snapshot'}
      </Button>
      {create.error !== null && (
        <p role="alert" className="text-xs text-danger-text">
          {errorText(create.error)}
        </p>
      )}
    </form>
  );
}

function DiffPane({
  orgSlug,
  projectId,
  snapshot,
  snapshots,
  compareTo,
  onCompareTo,
  onDeleted,
}: {
  readonly orgSlug: string;
  readonly projectId: string;
  readonly snapshot: Snapshot;
  readonly snapshots: readonly Snapshot[];
  readonly compareTo: string | null;
  readonly onCompareTo: (id: string | null) => void;
  readonly onDeleted: () => void;
}) {
  const diff = useQuery(diffQueryOptions(projectId, snapshot.id, compareTo));
  // The live diff also carries `fullView` and the counts the restore dialog needs.
  const live = useQuery(diffQueryOptions(projectId, snapshot.id, null));
  const ir = useQuery(irQueryOptions(projectId));
  // Phase 10b Q3: a protected project takes no restore; say so instead of offering one.
  const isProtected = useQuery(projectShellQueryOptions(projectId)).data?.requireChangeRequests;
  const [hideCosmetic, setHideCosmetic] = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [showSql, setShowSql] = useState(false);
  // R21′: the API refuses a migration from a partial view; say why before the click.
  const sqlBlocked = live.data?.fullView === false;

  const entityName = (id: string): string | null => ir.data?.objects.entity[id]?.name ?? null;

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-sm font-medium text-text">{snapshot.name}</h1>
        <span className="text-xs text-text-muted">→</span>
        <select
          aria-label="Compare with"
          value={compareTo ?? ''}
          onChange={(e) => {
            onCompareTo(e.target.value === '' ? null : e.target.value);
          }}
          className="h-7 rounded border border-border bg-surface px-1 text-xs text-text"
        >
          <option value="">Current schema</option>
          {snapshots
            .filter((s) => s.id !== snapshot.id)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
        <Button
          size="sm"
          variant={showSql && !sqlBlocked ? 'outline' : 'ghost'}
          aria-pressed={showSql && !sqlBlocked}
          disabled={sqlBlocked}
          title={
            sqlBlocked ? 'Migration SQL needs access to every table in the project.' : undefined
          }
          onClick={() => {
            setShowSql((on) => !on);
          }}
        >
          Migration SQL
        </Button>
        <label className="ml-auto flex items-center gap-1 text-xs text-text-muted">
          <input
            type="checkbox"
            checked={hideCosmetic}
            onChange={(e) => {
              setHideCosmetic(e.target.checked);
            }}
          />
          Hide cosmetic
        </label>
        {isProtected !== true && (
          <Button
            size="sm"
            variant="outline"
            disabled={live.data?.fullView !== true}
            title={
              live.data?.fullView === false
                ? 'Restoring needs access to every table in the project.'
                : undefined
            }
            onClick={() => {
              setRestoring(true);
            }}
          >
            Restore
          </Button>
        )}
        {snapshot.kind === 'manual' && (
          <DeleteButton projectId={projectId} snapshotId={snapshot.id} onDeleted={onDeleted} />
        )}
      </header>
      {snapshot.description !== null && (
        <p className="text-xs text-text-muted">{snapshot.description}</p>
      )}
      {isProtected === true && (
        <p className="text-xs text-text-muted">
          This project is protected, so it can’t be restored directly. Propose a change, or ask a
          manager to turn off “Require change requests” first.
        </p>
      )}
      {live.data?.fullView === false && (
        <p className="text-xs text-text-muted">
          Restore is unavailable: it needs access to every table in the project.
        </p>
      )}
      {showSql && !sqlBlocked ? (
        <MigrationPane projectId={projectId} from={snapshot} to={compareTo} />
      ) : diff.error !== null ? (
        <p role="alert" className="text-xs text-danger-text">
          {errorText(diff.error)}
        </p>
      ) : diff.data === undefined ? (
        <p className="text-xs text-text-subtle">Loading the diff…</p>
      ) : (
        <DiffBody
          diff={diff.data}
          hideCosmetic={hideCosmetic}
          entityName={entityName}
          canvasHref={(id) =>
            entityName(id) === null
              ? null
              : `/${encodeURIComponent(orgSlug)}/p/${encodeURIComponent(projectId)}?select=${encodeURIComponent(id)}`
          }
        />
      )}
      {live.data !== undefined && (
        <RestoreDialog
          open={restoring}
          onOpenChange={setRestoring}
          projectId={projectId}
          snapshot={snapshot}
          live={live.data}
        />
      )}
    </div>
  );
}

/**
 * Doc 03 §11.2 — the engine's migration plan. Red and amber come straight off each step's
 * `destructive` / `lossy`, never from parsing the SQL, so this and the diff cannot disagree.
 */
function MigrationPane({
  projectId,
  from,
  to,
}: {
  readonly projectId: string;
  readonly from: Snapshot;
  readonly to: string | null;
}) {
  const [allowDestructive, setAllowDestructive] = useState(false);
  const plan = useQuery(migrationQueryOptions(projectId, from.id, to, allowDestructive));

  if (plan.error !== null) {
    const status = plan.error instanceof ApiError ? plan.error.status : 0;
    return (
      <p role="alert" className="text-xs text-danger-text">
        {status === 403
          ? 'Migration SQL needs access to every table in the project.'
          : errorText(plan.error)}
      </p>
    );
  }
  if (plan.data === undefined)
    return <p className="text-xs text-text-subtle">Generating the migration…</p>;

  return (
    <PlanBody
      plan={plan.data}
      fileName={`migration-${from.name}`}
      allowDestructive={allowDestructive}
      onAllowDestructive={setAllowDestructive}
    />
  );
}

/** A migration plan: counts, copy/download, manual steps, then each step. Shared by the
 *  snapshot migration and the drift check (Phase 6 §6). Without `onAllowDestructive` the
 *  toggle is hidden: the drift check chooses before it reads the database. */
export function PlanBody({
  plan,
  fileName,
  allowDestructive,
  onAllowDestructive,
}: {
  readonly plan: MigrationView;
  readonly fileName: string;
  readonly allowDestructive: boolean;
  readonly onAllowDestructive?: (on: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const { steps, summary, unsupported, script, fileExtension } = plan;
  const download = () => {
    const url = URL.createObjectURL(new Blob([script], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileName.replace(/[^\w.-]+/g, '_')}.${fileExtension}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Chip>{summary.total} steps</Chip>
        <Chip warn={summary.destructive > 0}>{summary.destructive} destructive</Chip>
        <Chip warn={summary.lossy > 0}>{summary.lossy} lossy</Chip>
        <Chip>{summary.rewrites} locking</Chip>
        {onAllowDestructive !== undefined && (
          <label className="ml-auto flex items-center gap-1 text-text-muted">
            <input
              type="checkbox"
              checked={allowDestructive}
              onChange={(e) => {
                onAllowDestructive(e.target.checked);
              }}
            />
            Include destructive steps
          </label>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={steps.length === 0}
          onClick={() => {
            void navigator.clipboard.writeText(script).then(() => {
              setCopied(true);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button size="sm" variant="outline" disabled={steps.length === 0} onClick={download}>
          Download .{fileExtension}
        </Button>
      </div>
      {!allowDestructive && summary.destructive > 0 && (
        <p className="text-xs text-text-muted">
          Destructive steps are commented out in the script. Tick “Include destructive steps” to run
          them{onAllowDestructive === undefined ? ' (then compare again)' : ''}.
        </p>
      )}
      {unsupported.length > 0 && (
        <details open className="rounded border border-warning bg-warning-subtle">
          <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium text-warning-text">
            {unsupported.length} change{unsupported.length === 1 ? ' needs' : 's need'} a manual
            step
          </summary>
          <ul className="flex flex-col gap-0.5 border-t border-warning px-2 py-1.5 text-xs text-text">
            {unsupported.map((u, i) => (
              <li key={i}>
                {u.change} — <span className="text-text-muted">{u.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {steps.length === 0 && unsupported.length === 0 && (
        <p className="text-sm text-text-muted">No schema changes to migrate.</p>
      )}
      <ol className="flex flex-col gap-1.5">
        {steps.map((step) => (
          <StepRow key={step.ordinal} step={step} />
        ))}
      </ol>
    </div>
  );
}

function StepRow({ step }: { readonly step: MigrationStep }) {
  return (
    <li
      className={cn(
        'flex flex-col gap-1 rounded border px-2 py-1.5',
        step.destructive
          ? 'border-danger bg-danger-subtle'
          : step.lossy
            ? 'border-warning bg-warning-subtle'
            : 'border-border',
      )}
    >
      <span className="flex flex-wrap items-center gap-2 text-[10px] text-text-subtle uppercase">
        <span>{step.kind}</span>
        {step.destructive && <span className="text-danger-text">destructive</span>}
        {step.lossy && <span className="text-warning-text">lossy</span>}
        {step.requiresTableRewrite && <span>locks the table</span>}
        {step.commentedOut && <span>commented out</span>}
      </span>
      <pre
        className={cn(
          'font-mono text-xs whitespace-pre-wrap text-text',
          step.commentedOut && 'line-through opacity-60',
        )}
      >
        {step.text}
      </pre>
      {step.reason !== null && (
        <span className={cn('text-xs', step.destructive ? 'text-danger-text' : 'text-text-muted')}>
          {step.reason}
        </span>
      )}
    </li>
  );
}

export function DiffBody({
  diff,
  hideCosmetic,
  entityName,
  canvasHref,
}: {
  readonly diff: HistoryDiff;
  readonly hideCosmetic: boolean;
  readonly entityName: (id: string) => string | null;
  readonly canvasHref: (entityId: string) => string | null;
}) {
  const shown = useMemo(
    () => (hideCosmetic ? diff.entries.filter((e) => !isCosmeticOnly(e)) : diff.entries),
    [diff.entries, hideCosmetic],
  );
  const groups = useMemo(() => groupByEntity(shown), [shown]);
  const other = shown.filter((e) => e.objectType !== 'entity' && e.ownerEntityId === undefined);
  const { counts } = diff;

  return (
    <div className="flex flex-col gap-3">
      <p className="flex flex-wrap gap-2 text-xs">
        <Chip>{counts.added} added</Chip>
        <Chip>{counts.removed} removed</Chip>
        <Chip>{counts.changed} changed</Chip>
        <Chip>{counts.structural} structural</Chip>
        <Chip warn={counts.governance > 0}>{counts.governance} governance</Chip>
      </p>
      {shown.length === 0 && <p className="text-sm text-text-muted">No differences.</p>}
      {[...groups].map(([entityId, entries]) => {
        const own = entries.find((e) => e.objectType === 'entity');
        const href = canvasHref(entityId);
        return (
          <details key={entityId} open className="rounded border border-border">
            <summary className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm text-text">
              <span className="font-medium">
                {own === undefined ? (entityName(entityId) ?? entityId) : entryName(own)}
              </span>
              <span className="text-xs text-text-subtle">
                {entries.length} change{entries.length === 1 ? '' : 's'}
              </span>
              {href !== null && (
                <Link href={href} className="ml-auto text-xs text-accent hover:underline">
                  Show on canvas
                </Link>
              )}
            </summary>
            <ul className="flex flex-col border-t border-border">
              {entries.map((e) => (
                <EntryRow key={`${e.objectType}:${e.id}`} entry={e} />
              ))}
            </ul>
          </details>
        );
      })}
      {other.length > 0 && (
        <details open className="rounded border border-border">
          <summary className="cursor-pointer px-2 py-1.5 text-sm font-medium text-text">
            Other
          </summary>
          <ul className="flex flex-col border-t border-border">
            {other.map((e) => (
              <EntryRow key={`${e.objectType}:${e.id}`} entry={e} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

const show = (value: unknown): string => {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'string') return value;
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
};

function EntryRow({ entry }: { readonly entry: DiffEntry }) {
  const properties: readonly DiffProperty[] = entry.properties ?? [];
  const severities =
    entry.change === 'changed' ? [...new Set(properties.map((p) => p.severity))] : ['structural'];
  const governance = severities.includes('governance');
  return (
    <li
      className={cn('flex flex-col gap-1 px-2 py-1.5 text-xs', governance && 'bg-warning-subtle')}
    >
      <span className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'rounded px-1 font-medium',
            entry.change === 'added' && 'text-text',
            entry.change === 'removed' && 'text-danger-text',
            entry.change === 'changed' && 'text-text-muted',
          )}
        >
          {entry.change}
        </span>
        <span className="text-text-subtle">{entry.objectType}</span>
        <span className="text-text">{entryName(entry)}</span>
        {severities.map((s) => (
          <Chip key={s} warn={s === 'governance'}>
            {s}
          </Chip>
        ))}
      </span>
      {properties.length > 0 && (
        <ul className="flex flex-col gap-0.5 pl-4 font-mono text-text-muted">
          {properties.map((p) => (
            <li
              key={p.path.join('.')}
              className={cn(p.severity === 'governance' && 'text-warning-text')}
            >
              {p.path.join('.')}: {show(p.before)} → {show(p.after)}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Chip({
  children,
  warn = false,
}: {
  readonly children: ReactNode;
  readonly warn?: boolean;
}) {
  return (
    <span
      className={cn(
        'rounded border px-1.5 text-[10px]',
        warn
          ? 'border-warning bg-warning-subtle text-warning-text'
          : 'border-border text-text-muted',
      )}
    >
      {children}
    </span>
  );
}

function RestoreDialog({
  open,
  onOpenChange,
  projectId,
  snapshot,
  live,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projectId: string;
  readonly snapshot: Snapshot;
  readonly live: HistoryDiff;
}) {
  const queryClient = useQueryClient();
  const restore = useMutation({
    mutationFn: () => restoreSnapshot(projectId, snapshot.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      onOpenChange(false);
    },
  });
  // The live diff is snapshot → current; restoring goes current → snapshot, so adds and
  // removes swap sides.
  const summary = summarize({
    ...live.counts,
    added: live.counts.removed,
    removed: live.counts.added,
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!restore.isPending) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogTitle>Restore “{snapshot.name}”?</DialogTitle>
        <DialogDescription>
          Current schema → this snapshot: {summary}. A snapshot of the current schema is taken
          first, so this can be undone. Access settings (restricted columns, areas) are kept as they
          are now.
        </DialogDescription>
        {restore.error !== null && (
          <p role="alert" className="text-xs text-danger-text">
            {errorText(restore.error)}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={restore.isPending || live.fullView !== true}
            onClick={() => {
              restore.mutate();
            }}
          >
            {restore.isPending ? 'Restoring…' : 'Restore'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteButton({
  projectId,
  snapshotId,
  onDeleted,
}: {
  readonly projectId: string;
  readonly snapshotId: string;
  readonly onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => deleteSnapshot(projectId, snapshotId),
    onSuccess: async () => {
      onDeleted();
      await queryClient.invalidateQueries({ queryKey: snapshotsKey(projectId) });
    },
  });
  if (!confirming) {
    return (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setConfirming(true);
        }}
      >
        Delete
      </Button>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-text-muted">
      Delete this snapshot?
      <Button
        size="sm"
        variant="danger"
        disabled={remove.isPending}
        onClick={() => {
          remove.mutate();
        }}
      >
        Delete
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setConfirming(false);
        }}
      >
        Keep
      </Button>
      {remove.error !== null && <span className="text-danger-text">{errorText(remove.error)}</span>}
    </span>
  );
}
