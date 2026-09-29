'use client';

import type { DocRef, Id } from '@schemaloom/schema-model';
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useTerminology } from '@/engines';
import { irQueryOptions } from '@/features/canvas/ir-query';
import { useCanvasStore } from '@/features/canvas/store';
import { ApiError } from '@/lib/api-client';
import { DocEditor } from './docs-editor';
import { docQueryOptions, type DocTarget } from './docs-api';

/**
 * The inspector's Docs tab: the selected column, else the selected table, else the
 * project. A stub or masked column has no doc to show (doc 05 §8).
 */
export function DocsPanel({ projectId }: { readonly projectId: Id }) {
  const { data: model } = useSuspenseQuery(irQueryOptions(projectId));
  const t = useTerminology();
  const selection = useCanvasStore((s) => s.selection);
  const selectedFieldId = useCanvasStore((s) => s.selectedFieldId);

  const only = selection.size === 1 ? [...selection][0] : undefined;
  const entity = only === undefined ? undefined : model.objects.entity[only];
  const field = selectedFieldId === null ? undefined : model.objects.field[selectedFieldId];
  if (selection.size > 1) {
    return <p className="p-2 text-sm text-text-muted">{t.msg('inspector.noSelection', 'entity')}</p>;
  }
  if (entity?.restricted === true || field?.restricted === true) {
    return <p className="p-2 text-sm text-text-subtle">restricted</p>;
  }

  const target: DocTarget =
    field !== undefined
      ? { targetType: 'field', targetId: field.id }
      : entity !== undefined
        ? { targetType: 'entity', targetId: entity.id }
        : { targetType: 'project', targetId: projectId };
  const title =
    field !== undefined && entity !== undefined
      ? `${entity.name}.${field.name}`
      : (entity?.name ?? 'Project documentation');
  return (
    <TargetDoc
      key={`${target.targetType}:${target.targetId}`}
      projectId={projectId}
      target={target}
      title={title}
      docRef={field?.doc ?? entity?.doc ?? null}
    />
  );
}

function TargetDoc({
  projectId,
  target,
  title,
  docRef,
}: {
  readonly projectId: Id;
  readonly target: DocTarget;
  readonly title: string;
  readonly docRef: DocRef | null;
}) {
  const queryClient = useQueryClient();
  const options = docQueryOptions(projectId, target);
  const query = useQuery(options);

  // Another writer's save reaches this reader as a `schema:patch` carrying the object's
  // refreshed `DocRef` (doc 04 §8.10); that is the cue to refetch the full doc.
  const seen = useRef(docRef);
  useEffect(() => {
    if (seen.current?.id === docRef?.id && seen.current?.excerpt === docRef?.excerpt) return;
    seen.current = docRef;
    void queryClient.invalidateQueries({ queryKey: options.queryKey });
  }, [docRef, queryClient, options.queryKey]);

  return (
    <div className="space-y-2 overflow-auto p-2">
      <h2 className="truncate font-mono text-sm font-medium text-text">{title}</h2>
      {query.error !== null ? (
        <p role="alert" className="text-xs text-danger-text">
          {query.error instanceof ApiError && query.error.status === 404
            ? 'This is not available.'
            : 'Could not load the documentation.'}
        </p>
      ) : query.data === undefined ? (
        <p className="text-xs text-text-subtle">Loading…</p>
      ) : (
        <DocEditor
          projectId={projectId}
          target={target}
          doc={query.data}
          withFacts={target.targetType === 'field'}
        />
      )}
    </div>
  );
}
