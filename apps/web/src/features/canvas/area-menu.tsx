'use client';

import { Popover, PopoverAnchor, PopoverContent } from '@schemaloom/ui';
import { useQuery } from '@tanstack/react-query';
import { accessQueryOptions } from '@/features/sharing/sharing-api';
import { AREA_COLOR_COUNT, areaToken, slotOf } from './area-color';
import type { AreaNodeData } from './graph';

export interface AreaMenuTarget {
  readonly x: number;
  readonly y: number;
  readonly data: AreaNodeData;
}

const item =
  'w-full rounded px-2 py-1.5 text-left text-sm text-text hover:bg-surface-hover disabled:text-text-subtle';

/**
 * The menu behind a card's name label: Rename, Colour, Ungroup, and Share for managers.
 * A Popover at the pointer, like `CanvasMenu` (the design system has no ContextMenu).
 *
 * "Managers only" is the same answer the sharing dialog gives (`canManage` on
 * `GET /access`), asked only once the menu is open.
 */
export function AreaMenu({
  projectId,
  target,
  onClose,
  onRename,
  onColour,
  onUngroup,
  onShare,
}: {
  readonly projectId: string;
  readonly target: AreaMenuTarget | null;
  readonly onClose: () => void;
  readonly onRename: (data: AreaNodeData) => void;
  readonly onColour: (data: AreaNodeData, token: string) => void;
  readonly onUngroup: (data: AreaNodeData) => void;
  readonly onShare: (data: AreaNodeData) => void;
}) {
  const access = useQuery({ ...accessQueryOptions(projectId), enabled: target !== null });
  const data = target?.data;
  const current = data === undefined ? null : slotOf(data.area.color);

  return (
    <Popover
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PopoverAnchor asChild>
        <span
          aria-hidden="true"
          className="fixed size-0"
          style={{ left: target?.x ?? 0, top: target?.y ?? 0 }}
        />
      </PopoverAnchor>
      <PopoverContent align="start" side="bottom" sideOffset={2} className="w-56 p-1">
        {data === undefined ? null : (
          <div role="menu" aria-label={`${data.area.name} options`}>
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                onRename(data);
                onClose();
              }}
            >
              Rename
            </button>
            <div role="group" aria-label="Colour" className="flex flex-wrap gap-1.5 px-2 py-1.5">
              {Array.from({ length: AREA_COLOR_COUNT }, (_, slot) => (
                <button
                  key={slot}
                  type="button"
                  aria-label={`Colour ${String(slot + 1)}`}
                  aria-pressed={current === slot}
                  className="size-5 rounded-full border-2 aria-pressed:ring-2 aria-pressed:ring-accent aria-pressed:ring-offset-1"
                  style={{
                    backgroundColor: `var(--area-hue-${String(slot + 1)})`,
                    borderColor: 'transparent',
                  }}
                  onClick={() => {
                    onColour(data, areaToken(slot));
                    onClose();
                  }}
                />
              ))}
            </div>
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                onUngroup(data);
                onClose();
              }}
            >
              Ungroup
            </button>
            {access.data?.canManage === true && (
              <button
                type="button"
                role="menuitem"
                className={item}
                onClick={() => {
                  onShare(data);
                  onClose();
                }}
              >
                Share this area
              </button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
