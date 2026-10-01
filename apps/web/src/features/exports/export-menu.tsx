'use client';

import {
  Button,
  ChevronDown,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@schemaloom/ui';
import { useQuery } from '@tanstack/react-query';
import { Fragment, useCallback, useState } from 'react';
import { useEngine } from '@/engines';
import { irQueryOptions } from '@/features/canvas/ir-query';
import { EngineGate } from '@/features/project/engine-gate';
import { renderCanvasImage } from './canvas-image';
import {
  exportErrorMessage,
  runImageExport,
  runServerExport,
  startDownload,
  type ImageFormat,
} from './exports-api';

const isImage = (format: string): format is ImageFormat => format === 'png' || format === 'svg';

/**
 * Run one export end to end: render or queue, wait, download. Exported so docs mode can
 * put an "Export PDF" button in its own header (`run('pdf')`) without the menu.
 */
export function useExport(projectId: string) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (format: string, areaId?: string): Promise<void> => {
      setBusy(format);
      setError(null);
      try {
        const url = isImage(format)
          ? await runImageExport(projectId, format, await renderCanvasImage(format))
          : await runServerExport(projectId, format, areaId);
        startDownload(url);
      } catch (caught) {
        setError(exportErrorMessage(caught));
      } finally {
        setBusy(null);
      }
    },
    [projectId],
  );

  return { run, busy, error };
}

/**
 * The project header's Export menu (Phase 5 §5). DDL formats are the open project's
 * engine's own exporter descriptors — read from the engine facet, like every other
 * capability on the client, so no engine id is written here. `images: false` drops the
 * diagram entries on a page without a canvas.
 *
 * Scope (Q29): the areas the caller can see are offered too, because a grant on one area
 * holds `export:run` there and not at the project. The client does not know the caller's
 * atoms, so a scope they cannot export answers the usual 403 message.
 */
export function ExportMenu({
  projectId,
  images = true,
}: {
  readonly projectId: string;
  readonly images?: boolean;
}) {
  return (
    <EngineGate
      projectId={projectId}
      fallback={
        <span className="px-2 text-sm text-text-subtle" aria-hidden="true">
          Export
        </span>
      }
    >
      <ExportMenuInner projectId={projectId} images={images} />
    </EngineGate>
  );
}

function ExportMenuInner({
  projectId,
  images,
}: {
  readonly projectId: string;
  readonly images: boolean;
}) {
  const engine = useEngine();
  const { run, busy, error } = useExport(projectId);
  const { data: model } = useQuery(irQueryOptions(projectId));
  const areas = Object.values(model?.objects.area ?? {}).sort((a, b) => a.ordinal - b.ordinal);
  const [areaId, setAreaId] = useState<string | null>(null);
  // A deleted or newly hidden area falls back to the whole project.
  const scope = areas.some((a) => a.id === areaId) ? areaId : null;

  const groups: { id: string; label: string }[][] = [
    engine.capabilities.exportFormats.map((f) => ({ id: f.id, label: f.displayName })),
    [
      { id: 'ir-json', label: 'Schema (JSON)' },
      { id: 'markdown', label: 'Documentation (Markdown)' },
      { id: 'pdf', label: 'Documentation (PDF)' },
    ],
    images && scope === null
      ? [
          { id: 'png', label: 'Diagram (PNG)' },
          { id: 'svg', label: 'Diagram (SVG)' },
        ]
      : [],
  ].filter((group) => group.length > 0);

  return (
    <span className="flex items-center gap-2">
      {error !== null && (
        <span role="alert" className="text-xs text-danger-text">
          {error}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" disabled={busy !== null}>
            {busy === null ? 'Export' : 'Exporting…'}
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {areas.length > 0 && (
            <>
              <DropdownMenuLabel>Scope</DropdownMenuLabel>
              {[{ id: null, name: 'Whole project' }, ...areas].map((a) => (
                <DropdownMenuCheckboxItem
                  key={a.id ?? ''}
                  checked={scope === a.id}
                  onSelect={(event) => {
                    event.preventDefault(); // keep the menu open to pick a format
                    setAreaId(a.id);
                  }}
                >
                  {a.name === '' ? 'Untitled area' : a.name}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
            </>
          )}
          {groups.map((group, i) => (
            <Fragment key={group[0]?.id ?? i}>
              {i > 0 && <DropdownMenuSeparator />}
              {group.map((item) => (
                <DropdownMenuItem
                  key={item.id}
                  onSelect={() => {
                    void run(item.id, scope ?? undefined);
                  }}
                >
                  {item.label}
                </DropdownMenuItem>
              ))}
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
