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
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useEngine } from '@/engines';
import { DescribeSchema } from '@/features/ai/describe-schema';
import { SshHostKeyNote, readsDatabase } from '@/features/projects/connection-form';
import {
  detectImportFormat,
  fetchTemplate,
  importInto,
  importIntrospected,
  importSourceName,
  introspectPreview,
  listTemplates,
  previewImport,
  type ConfirmedRename,
  type Imported,
  type RenameCandidate,
} from '@/features/projects/create-project';
import { ConnectionSection, useConnectionChoice } from '@/features/projects/saved-connection';
import { ApiError } from '@/lib/api-client';

type EntityCandidate = Extract<RenameCandidate, { type: 'entity' }>;
type FieldCandidate = Extract<RenameCandidate, { type: 'field' }>;

/**
 * SQL import into the open project. Same call as the project-list import (inline up to
 * 5 MB, queued above), and additive: existing objects win and nothing is deleted.
 *
 * Phase 4 §2.1: the source is previewed first, and when it looks like a table or column
 * was renamed the dialog asks. Nothing is inferred — "Keep both" is the default, and only
 * the pairs the user marks "Rename" are sent.
 *
 * Phase 6 §5: "From a database" (when the engine declares a connection form) reads the schema
 * on the server, then follows the same preview → renames → import steps. 6c: with a saved
 * connection that tab is "Sync now", and the toolbar's Sync opens the dialog on it.
 */
export function ImportDialog({
  open,
  onOpenChange,
  projectId,
  onImported,
  initialFrom = 'sql',
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projectId: string;
  readonly onImported: () => Promise<void>;
  /** 'database' for the toolbar's Sync; 'describe' for the empty canvas's Describe card */
  readonly initialFrom?: 'sql' | 'database' | 'describe';
}) {
  const facet = useEngine();
  const formats = facet.capabilities.importFormats;
  const connectionFields = facet.capabilities.connectionFields;
  const [from, setFrom] = useState<'sql' | 'database'>(
    initialFrom === 'database' ? 'database' : 'sql',
  );
  // Phase 12 — "Load a template" fills the SQL box, like Describe does.
  const templates = useQuery({
    queryKey: ['engine-templates', facet.id],
    queryFn: () => listTemplates(facet.id),
    enabled: open,
    staleTime: Infinity,
  });
  const choice = useConnectionChoice(
    projectId,
    connectionFields,
    facet.capabilities.introspection === 'file',
  );
  /** "Not saved: only managers can…" after a read that fell back to the typed details */
  const [note, setNote] = useState<string | null>(null);
  /** The introspected dump waiting on the server (Phase 6 §4). */
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [sshHostKey, setSshHostKey] = useState<string | undefined>(undefined);
  const [source, setSource] = useState('');
  // Phase 7b — a pasted or chosen `schema.prisma` is read as one.
  const detected = detectImportFormat(source, formats);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Imported | null>(null);
  /** Confirmed table renames, as `from → to`, for the result summary. */
  const [renamed, setRenamed] = useState<readonly string[]>([]);
  const [candidates, setCandidates] = useState<readonly RenameCandidate[] | null>(null);
  /** Confirmed candidate keys (`type:fromId`). */
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set());

  const close = (next: boolean) => {
    if (busy) return;
    onOpenChange(next);
    if (!next) {
      setFrom(initialFrom === 'database' ? 'database' : 'sql');
      choice.reset();
      setNote(null);
      setSourceId(null);
      setSshHostKey(undefined);
      setSource('');
      setError(null);
      setResult(null);
      setRenamed([]);
      setCandidates(null);
      setConfirmed(new Set());
    }
  };

  const fail = (caught: unknown) => {
    setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Try again.');
  };

  const run = async (renames: readonly ConfirmedRename[], introspected = sourceId) => {
    const imported =
      introspected === null
        ? await importInto(projectId, source, renames, detected)
        : await importIntrospected(projectId, introspected, renames);
    await onImported();
    setResult(imported);
  };

  const submitSource = () => {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        if (from === 'database') {
          const resolved = await choice.resolve();
          setNote(resolved.note ?? null);
          const read = await introspectPreview(projectId, resolved.source);
          setSourceId(read.sourceId);
          setSshHostKey(read.sshHostKey);
          if (read.preview.renameCandidates.length > 0) {
            setCandidates(read.preview.renameCandidates);
            return;
          }
          await run([], read.sourceId);
          return;
        }
        const preview = await previewImport(projectId, source, detected);
        if (preview !== null && preview.renameCandidates.length > 0) {
          setCandidates(preview.renameCandidates);
          return;
        }
        await run([]);
      } catch (caught) {
        fail(caught);
      } finally {
        setBusy(false);
      }
    })();
  };

  const entities = (candidates ?? []).filter((c): c is EntityCandidate => c.type === 'entity');
  const fields = (candidates ?? []).filter((c): c is FieldCandidate => c.type === 'field');
  const renamedEntity = new Set(
    entities.filter((c) => confirmed.has(`entity:${c.fromId}`)).map((c) => c.fromId),
  );
  const proposedEntity = new Set(entities.map((c) => c.fromId));
  /** A field pair inside a table rename only applies when that rename is confirmed. */
  const fieldApplies = (c: FieldCandidate) =>
    !proposedEntity.has(c.entityId) || renamedEntity.has(c.entityId);

  const submitRenames = () => {
    const tables = entities.filter((c) => confirmed.has(`entity:${c.fromId}`));
    setRenamed(tables.map((c) => `${c.fromName} → ${c.toName}`));
    const renames: ConfirmedRename[] = [
      ...tables,
      ...fields.filter((c) => fieldApplies(c) && confirmed.has(`field:${c.fromId}`)),
    ].map((c) => ({ type: c.type, fromId: c.fromId, toName: c.toName }));
    setBusy(true);
    setError(null);
    run(renames)
      .catch(fail)
      .finally(() => {
        setBusy(false);
      });
  };

  const toggle = (key: string, on: boolean) => {
    const next = new Set(confirmed);
    if (on) next.add(key);
    else next.delete(key);
    setConfirmed(next);
  };

  // `ignored` is SET, COMMENT, GRANT…: nothing the schema lost, so it isn't listed as a loss.
  const notApplied =
    result?.report.statements.filter((s) => s.status !== 'applied' && s.status !== 'ignored') ?? [];
  const ignored = result?.report.statements.filter((s) => s.status === 'ignored').length ?? 0;
  const renamedTo = new Set(
    entities.filter((c) => confirmed.has(`entity:${c.fromId}`)).map((c) => c.toName),
  );
  const unchanged = (result?.existing ?? []).filter((name) => !renamedTo.has(name));
  const matchedFields = fields.filter((c) => !proposedEntity.has(c.entityId));

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>
          {from === 'database'
            ? 'Import from a database'
            : detected === 'prisma'
              ? 'Import a Prisma schema'
              : initialFrom === 'describe'
                ? 'Describe with AI'
                : `Import ${importSourceName(formats)}`}
        </DialogTitle>
        <DialogDescription>
          Adds what the project does not have yet. Existing objects are left unchanged, except for
          renames you confirm.
        </DialogDescription>
        {result !== null ? (
          <div className="mt-4 flex flex-col gap-2 text-xs">
            <p className="text-sm text-text">
              {result.report.statementCount - notApplied.length - ignored} of{' '}
              {result.report.statementCount - ignored} schema statements applied.
            </p>
            {ignored > 0 && (
              <p className="text-text-muted">
                Skipped {ignored} statement{ignored === 1 ? '' : 's'} that don’t describe the schema
                (session settings, comments, grants).
              </p>
            )}
            <SshHostKeyNote hostKey={sshHostKey} />
            {note !== null && <p className="text-text-muted">{note}</p>}
            {renamed.length > 0 && <p className="text-text-muted">Renamed: {renamed.join(', ')}</p>}
            {unchanged.length > 0 && (
              <p className="text-text-muted">
                Already in the project, left unchanged: {unchanged.join(', ')}
              </p>
            )}
            {notApplied.length > 0 && (
              <ul className="flex max-h-64 flex-col gap-2 overflow-auto">
                {notApplied.map((statement) => (
                  <li key={statement.ordinal}>
                    <code className="block truncate text-text">{statement.excerpt}</code>
                    <span className="text-text-muted">
                      {statement.status}: {statement.reason}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <DialogFooter>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  close(false);
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : candidates !== null ? (
          <div className="mt-4 flex flex-col gap-3 text-xs">
            <p className="text-sm text-text">Looks like a rename?</p>
            <ul className="flex max-h-96 flex-col gap-2 overflow-auto">
              {entities.map((c) => (
                <li key={c.fromId} className="rounded border border-border p-2">
                  <RenameCard
                    label={`Table ${c.fromName} → ${c.toName}`}
                    reason={c.reason}
                    on={confirmed.has(`entity:${c.fromId}`)}
                    onChange={(on) => {
                      toggle(`entity:${c.fromId}`, on);
                    }}
                  />
                  {renamedEntity.has(c.fromId) &&
                    fields
                      .filter((f) => f.entityId === c.fromId)
                      .map((f) => (
                        <div key={f.fromId} className="mt-2 border-t border-border pt-2 pl-4">
                          <RenameCard
                            label={`Column ${f.fromName} → ${f.toName}`}
                            reason={f.reason}
                            on={confirmed.has(`field:${f.fromId}`)}
                            onChange={(on) => {
                              toggle(`field:${f.fromId}`, on);
                            }}
                          />
                        </div>
                      ))}
                </li>
              ))}
              {matchedFields.map((f) => (
                <li key={f.fromId} className="rounded border border-border p-2">
                  <RenameCard
                    label={`Column ${f.entityName}.${f.fromName} → ${f.toName}`}
                    reason={f.reason}
                    on={confirmed.has(`field:${f.fromId}`)}
                    onChange={(on) => {
                      toggle(`field:${f.fromId}`, on);
                    }}
                  />
                </li>
              ))}
            </ul>
            {error !== null && (
              <p role="alert" className="text-xs text-danger-text">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setCandidates(null);
                  setConfirmed(new Set());
                }}
              >
                Back
              </Button>
              <Button variant="primary" size="sm" disabled={busy} onClick={submitRenames}>
                {busy ? 'Importing…' : 'Import'}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              submitSource();
            }}
          >
            {readsDatabase(facet.capabilities) && (
              <div role="group" aria-label="Import from" className="flex gap-1">
                {(
                  [
                    ['sql', importSourceName(formats)],
                    ['database', 'From a database'],
                  ] as const
                ).map(([value, text]) => (
                  <Button
                    key={value}
                    type="button"
                    size="sm"
                    variant={from === value ? 'primary' : 'outline'}
                    aria-pressed={from === value}
                    onClick={() => {
                      setFrom(value);
                      setError(null);
                    }}
                  >
                    {text}
                  </Button>
                ))}
              </div>
            )}
            {from === 'database' ? (
              <ConnectionSection choice={choice} fields={connectionFields} disabled={busy} />
            ) : (
              <>
                <DescribeSchema
                  projectId={projectId}
                  onDraft={setSource}
                  autoFocus={initialFrom === 'describe'}
                />
                {(templates.data?.length ?? 0) > 0 && (
                  <label className="flex flex-col gap-1 text-xs text-text-muted">
                    Load a template
                    <select
                      value=""
                      disabled={busy}
                      onChange={(e) => {
                        const id = e.target.value;
                        if (id === '') return;
                        setError(null);
                        fetchTemplate(facet.id, id).then(setSource, () => {
                          setError('Could not load the template. Try again.');
                        });
                      }}
                      className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-text"
                    >
                      <option value="">Choose a template…</option>
                      {templates.data?.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.title} ({template.tableCount} tables)
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <textarea
                  required
                  autoFocus={initialFrom !== 'describe'}
                  rows={12}
                  aria-label={importSourceName(formats)}
                  value={source}
                  onChange={(e) => {
                    setSource(e.target.value);
                  }}
                  className="rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-text"
                />
                <label className="flex flex-col gap-1 text-xs text-text-muted">
                  …or choose a file
                  <input
                    type="file"
                    accept={formats.flatMap((f) => f.fileExtensions).join(',')}
                    onChange={(e) => {
                      void e.target.files?.[0]?.text().then(setSource);
                    }}
                  />
                </label>
              </>
            )}
            {error !== null && (
              <p role="alert" className="text-xs text-danger-text">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={
                  busy ||
                  (from === 'sql' && source === '') ||
                  (from === 'database' && choice.saved === undefined)
                }
              >
                {busy
                  ? from === 'database'
                    ? 'Reading…'
                    : 'Importing…'
                  : from === 'database' && choice.saved && !choice.editing
                    ? 'Sync now'
                    : 'Import'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** One "Looks like a rename?" card: Rename / Keep both, Keep both by default. */
function RenameCard({
  label,
  reason,
  on,
  onChange,
}: {
  readonly label: string;
  readonly reason: string;
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-text">{label}</p>
        <p className="text-text-muted">{reason}</p>
      </div>
      <div role="group" aria-label={label} className="flex gap-1">
        {(
          [
            [true, 'Rename'],
            [false, 'Keep both'],
          ] as const
        ).map(([value, text]) => (
          <Button
            key={text}
            size="sm"
            variant={on === value ? 'primary' : 'outline'}
            aria-pressed={on === value}
            className={cn(on === value && 'pointer-events-none')}
            onClick={() => {
              onChange(value);
            }}
          >
            {text}
          </Button>
        ))}
      </div>
    </div>
  );
}
