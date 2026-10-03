'use client';

import { Loading, SkeletonRows } from '@schemaloom/ui';
import {
  createIndex,
  type Entity,
  type Field,
  type SchemaModel,
  type TypeRef,
} from '@schemaloom/schema-model';
import { useQuery } from '@tanstack/react-query';
import { useMemo, type ReactNode } from 'react';
import { useTerminology } from '@/engines';
import { irQueryOptions } from '@/features/canvas/ir-query';
import { RichText } from '@/features/comments/comment-composer';
import { ApiError } from '@/lib/api-client';
import { docCoverage } from './coverage';
import { docsListQueryOptions, fieldFacts, type DocView } from './docs-api';

/**
 * Phase 5 DESIGN §1 — docs mode. Left: tables by namespace. Right: the project doc, then
 * one section per table with its doc and a column table carrying each column's doc and
 * facts. Everything is what the API already filtered for this reader: the IR is redacted
 * and the docs list drops hidden targets and masked columns, so stubs and masked slots are
 * skipped here too and the coverage meter counts neither (L8).
 *
 * `actions` is the header slot the export menu fills.
 */
export function DocsView({
  projectId,
  actions,
}: {
  readonly projectId: string;
  readonly actions?: ReactNode;
}) {
  const ir = useQuery(irQueryOptions(projectId));
  const docs = useQuery(docsListQueryOptions(projectId));

  const error = ir.error ?? docs.error;
  if (error !== null) {
    const status = error instanceof ApiError ? error.status : 0;
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-text-muted">
        {status === 403 || status === 404
          ? 'This project is not available.'
          : 'Could not load the documentation.'}
      </div>
    );
  }
  if (ir.data === undefined || docs.data === undefined) {
    return (
      <Loading className="p-4">
        <SkeletonRows rows={5} />
      </Loading>
    );
  }
  return <Loaded projectId={projectId} model={ir.data} docs={docs.data} actions={actions} />;
}

const docKey = (targetType: string, targetId: string): string => `${targetType}:${targetId}`;

function Loaded({
  projectId,
  model,
  docs,
  actions,
}: {
  readonly projectId: string;
  readonly model: SchemaModel;
  readonly docs: readonly DocView[];
  readonly actions?: ReactNode;
}) {
  const t = useTerminology();
  const index = useMemo(() => createIndex(model), [model]);
  const byTarget = useMemo(
    () => new Map(docs.map((d) => [docKey(d.targetType, d.targetId), d])),
    [docs],
  );
  const coverage = useMemo(() => docCoverage(model), [model]);

  const groups = useMemo(
    () =>
      Object.values(model.objects.namespace)
        .map((ns) => ({
          ns,
          entities: (index.entitiesByNamespace.get(ns.id) ?? [])
            .filter((e) => e.restricted !== true)
            .sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .filter((g) => g.entities.length > 0)
        .sort((a, b) => a.ns.name.localeCompare(b.ns.name)),
    [model, index],
  );
  const primaryKey = useMemo(
    () =>
      new Set(
        Object.values(model.objects.constraint)
          .filter((c) => c.kind === 'primaryKey')
          .flatMap((c) => c.fieldIds),
      ),
    [model],
  );
  const pct = coverage.total === 0 ? 0 : Math.round((coverage.documented / coverage.total) * 100);
  const projectDoc = byTarget.get(docKey('project', projectId));

  return (
    <div className="flex h-full min-h-0">
      <nav
        aria-label={t.term('entity').other}
        className="w-56 shrink-0 overflow-auto border-r border-border p-3 text-sm"
      >
        {groups.map(({ ns, entities }) => (
          <div key={ns.id} className="mb-3">
            <p className="mb-1 text-xs font-medium text-text-subtle uppercase">{ns.name}</p>
            <ul className="space-y-0.5">
              {entities.map((e) => (
                <li key={e.id}>
                  <a
                    href={`#doc-${e.id}`}
                    className="block truncate rounded px-1 font-mono text-xs text-text-muted hover:bg-surface-hover hover:text-text"
                  >
                    {e.name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <main className="min-w-0 flex-1 overflow-auto p-6">
        <header className="mb-6 flex items-center gap-4">
          <h1 className="text-lg font-semibold text-text">Documentation</h1>
          <div
            className="flex items-center gap-2 text-xs text-text-muted"
            title="Visible objects with a doc"
          >
            <div
              role="meter"
              aria-label="Documented"
              aria-valuemin={0}
              aria-valuemax={coverage.total}
              aria-valuenow={coverage.documented}
              className="h-1.5 w-24 overflow-hidden rounded bg-surface-sunken"
            >
              <div className="h-full bg-accent" style={{ width: `${String(pct)}%` }} />
            </div>
            documented {coverage.documented}/{coverage.total}
          </div>
          <div className="ml-auto">{actions}</div>
        </header>

        <section className="mb-8">
          <h2 className="mb-2 text-sm font-medium text-text">Project</h2>
          <DocBody doc={projectDoc} />
        </section>

        {groups
          .flatMap(({ entities }) => entities)
          .map((entity) => (
            <EntitySection
              key={entity.id}
              entity={entity}
              fields={(index.fieldsByEntity.get(entity.id) ?? []).filter(
                (f) => f.restricted !== true,
              )}
              byTarget={byTarget}
              primaryKey={primaryKey}
            />
          ))}
      </main>
    </div>
  );
}

function EntitySection({
  entity,
  fields,
  byTarget,
  primaryKey,
}: {
  readonly entity: Entity;
  readonly fields: readonly Field[];
  readonly byTarget: ReadonlyMap<string, DocView>;
  readonly primaryKey: ReadonlySet<string>;
}) {
  const t = useTerminology();
  return (
    <section id={`doc-${entity.id}`} className="mb-8 scroll-mt-4">
      <h2 className="mb-2 font-mono text-sm font-semibold text-text">{entity.name}</h2>
      <DocBody doc={byTarget.get(docKey('entity', entity.id))} />
      <table className="mt-3 w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-border text-left text-text-subtle">
            <th className="py-1 pr-3 font-medium">{t.term('field').one}</th>
            <th className="py-1 pr-3 font-medium">Type</th>
            <th className="py-1 pr-3 font-medium">Flags</th>
            <th className="py-1 font-medium">Documentation</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => (
            <tr key={field.id} className="border-b border-border align-top">
              <td className="py-1.5 pr-3 font-mono text-text">{field.name}</td>
              <td className="py-1.5 pr-3 font-mono text-text-muted">{typeLabel(field.type)}</td>
              <td className="py-1.5 pr-3 text-text-muted">{flags(field, primaryKey).join(', ')}</td>
              <td className="py-1.5">
                <FieldDoc doc={byTarget.get(docKey('field', field.id))} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function DocBody({ doc }: { readonly doc: DocView | undefined }) {
  if (doc === undefined || doc.plainText === '') {
    return <p className="text-sm text-text-subtle">Not documented yet.</p>;
  }
  return <RichText doc={doc.content} />;
}

function FieldDoc({ doc }: { readonly doc: DocView | undefined }) {
  if (doc === undefined) return <span className="text-text-subtle">—</span>;
  const facts = fieldFacts(doc);
  const examples = facts.examples.filter((e) => e.trim() !== '');
  return (
    <div className="space-y-1">
      {doc.plainText === '' ? null : <RichText doc={doc.content} />}
      {facts.businessMeaning === '' ? null : <p className="text-text">{facts.businessMeaning}</p>}
      {facts.allowedValues.length === 0 ? null : (
        <ul className="text-text-muted">
          {facts.allowedValues.map((v, i) => (
            <li key={i}>
              <code className="font-mono">{v.value}</code>
              {v.meaning === '' ? null : ` — ${v.meaning}`}
            </li>
          ))}
        </ul>
      )}
      {examples.length === 0 ? null : (
        <p className="text-text-muted">
          e.g. <code className="font-mono">{examples.join(', ')}</code>
        </p>
      )}
      {facts.unit === null ? null : <p className="text-text-muted">Unit: {facts.unit}</p>}
    </div>
  );
}

function typeLabel(type: TypeRef): string {
  const args = type.args === undefined || type.args.length === 0 ? '' : `(${type.args.join(', ')})`;
  return `${type.name}${args}${'[]'.repeat(type.dimensions ?? 0)}`;
}

function flags(field: Field, primaryKey: ReadonlySet<string>): string[] {
  const out: string[] = [];
  if (primaryKey.has(field.id)) out.push('PK');
  out.push(field.isNullable ? 'null' : 'not null');
  if (field.isPii) out.push('PII');
  if (field.isRestricted) out.push('restricted');
  if (field.isDeprecated) out.push('deprecated');
  return out;
}
