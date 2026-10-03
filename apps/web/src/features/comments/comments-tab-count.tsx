'use client';

import type { Id } from '@schemaloom/schema-model';
import { useQuery } from '@tanstack/react-query';
import { useCanvasStore } from '@/features/canvas/store';
import { commentCountsQueryOptions } from './comments-api';

/**
 * The open-thread count for the tab label; counted server-side over visible targets (L8).
 * Its own file so the always-rendered rail badge doesn't pull TipTap into the page chunk.
 */
export function CommentsTabCount({ projectId }: { readonly projectId: Id }) {
  const selection = useCanvasStore((s) => s.selection);
  const { data } = useQuery(commentCountsQueryOptions(projectId));
  const only = selection.size === 1 ? [...selection][0] : undefined;
  const count = only === undefined ? 0 : (data?.[only] ?? 0);
  return count === 0 ? null : <span className="ml-1 text-xs text-text-subtle">{count}</span>;
}
