'use client';

import type { Area, Id, SchemaModel } from '@schemaloom/schema-model';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@schemaloom/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { accessQueryOptions } from '@/features/sharing/sharing-api';
import { ApiError } from '@/lib/api-client';
import { nextAreaName } from './area-card';
import { nextAreaToken } from './area-color';
import { accessLines, type AreaChange } from './area-access';
import { groupOps, moveOps, nextOrdinal, ungroupOps, updateAreaOp } from './area-ops';
import { postOps } from './schema-ops';

/**
 * Every area write, with the access confirmation in front of the ones that change who sees
 * a table. Shared by the canvas (group, drop, menu) and the inspector's Area field, so the
 * confirmation is one component and cannot be skipped by the second entry point; each
 * caller renders `dialog` once.
 *
 * Each action resolves `false` when the user cancels at the dialog, `true` once written,
 * and throws the API's error otherwise (the caller owns where the message appears).
 */
export function useAreaActions(projectId: Id, model: SchemaModel) {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState<{
    lines: readonly string[];
    settle: (ok: boolean) => void;
  } | null>(null);

  const confirmed = useCallback(
    async (change: AreaChange): Promise<boolean> => {
      let lines: string[];
      try {
        // Fresh, not cached: a grant added a minute ago must be in the sentence.
        const access = await queryClient.query({
          ...accessQueryOptions(projectId),
          staleTime: 0,
        });
        lines = accessLines(access, model, change);
      } catch {
        // The confirmation is a courtesy on top of a write the caller may already make.
        return true;
      }
      if (lines.length === 0) return true;
      return new Promise<boolean>((resolve) => {
        setAsking({ lines, settle: resolve });
      });
    },
    [queryClient, projectId, model],
  );

  const settle = (ok: boolean): void => {
    asking?.settle(ok);
    setAsking(null);
  };

  const areas = useMemo(() => Object.values(model.objects.area), [model]);
  const visible = (ids: readonly Id[]): Id[] =>
    ids.filter((id) => model.objects.entity[id]?.restricted !== true);
  const fromOf = (ids: readonly Id[]): Set<Id> =>
    new Set(ids.flatMap((id) => model.objects.entity[id]?.areaId ?? []));
  const namesOf = (ids: readonly Id[]): string[] =>
    ids.flatMap((id) => model.objects.entity[id]?.name ?? []);

  return {
    /** The new area's id, or `null` when cancelled. */
    async group(entityIds: readonly Id[]): Promise<Id | null> {
      const ids = visible(entityIds);
      if (ids.length === 0) return null;
      const id = crypto.randomUUID();
      if (!(await confirmed({ tables: namesOf(ids), from: fromOf(ids), to: null }))) return null;
      await postOps(
        queryClient,
        projectId,
        groupOps(model, ids, {
          id,
          name: nextAreaName(areas),
          color: nextAreaToken(areas),
          ordinal: nextOrdinal(areas),
        }),
        'Group into area',
      );
      return id;
    },

    /** Join a card, or leave every card (`areaId: null`). */
    async moveTo(entityIds: readonly Id[], areaId: Id | null): Promise<boolean> {
      const ops = moveOps(model, visible(entityIds), areaId);
      if (ops.length === 0) return true;
      const moved = ops.map((op) => op.id);
      if (!(await confirmed({ tables: namesOf(moved), from: fromOf(moved), to: areaId })))
        return false;
      await postOps(
        queryClient,
        projectId,
        ops,
        areaId === null ? 'Remove from area' : 'Add to area',
      );
      return true;
    },

    /** Keeps the tables, deletes the area. */
    async ungroup(area: Area): Promise<boolean> {
      const members = Object.values(model.objects.entity)
        .filter((e) => e.areaId === area.id && e.restricted !== true)
        .map((e) => e.id);
      if (
        !(await confirmed({
          tables: namesOf(members),
          from: new Set([area.id]),
          to: null,
          ungroup: true,
        }))
      )
        return false;
      await postOps(queryClient, projectId, ungroupOps(model, area), 'Ungroup area');
      return true;
    },

    async rename(area: Area, name: string): Promise<void> {
      await postOps(queryClient, projectId, [updateAreaOp(area, { name })], 'Rename area');
    },

    async recolour(area: Area, color: string): Promise<void> {
      await postOps(queryClient, projectId, [updateAreaOp(area, { color })], 'Recolour area');
    },

    dialog: (<AccessConfirm lines={asking?.lines ?? null} onSettle={settle} />) as ReactNode,
  };
}

function AccessConfirm({
  lines,
  onSettle,
}: {
  readonly lines: readonly string[] | null;
  readonly onSettle: (ok: boolean) => void;
}) {
  return (
    <Dialog
      open={lines !== null}
      onOpenChange={(open) => {
        if (!open) onSettle(false);
      }}
    >
      <DialogContent>
        <DialogTitle>This changes who can see these tables</DialogTitle>
        <DialogDescription asChild>
          <div className="mt-2 space-y-2 text-sm text-text-muted">
            {lines?.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </DialogDescription>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onSettle(false);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              onSettle(true);
            }}
          >
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One sentence for a failed area write; the API's own code is more useful than Nest's text. */
export function areaWriteMessage(caught: unknown): string {
  if (!(caught instanceof ApiError)) return 'Could not save. Try again.';
  if (caught.status === 409)
    return 'Someone else changed this. The diagram has been refreshed; try again.';
  if (caught.status === 423) return 'This project is protected. Propose the change instead.';
  if (caught.code === 'duplicate_name') return 'That name is already used by another area.';
  if (caught.status === 403 || caught.status === 404)
    return 'You do not have permission to change this.';
  return 'Could not save. Try again.';
}
