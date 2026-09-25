'use client';

import type { Id } from '@schemaloom/schema-model';
import { Popover, PopoverAnchor, PopoverContent } from '@schemaloom/ui';

/**
 * The right-click menu.
 *
 * §6.1 asks for Radix's `ContextMenu`, which is NOT a dependency of `@schemaloom/ui` and
 * cannot become one here — adding a package is out of scope for this step. `Popover`
 * anchored to a zero-size element at the pointer is the same Radix behaviour through a
 * primitive the design system already ships: focus trap, outside-click dismissal,
 * Escape, and portalled positioning that flips near a viewport edge.
 *
 * ponytail: swap `Popover` for `ContextMenu` the day `@radix-ui/react-context-menu` is
 * added to `@schemaloom/ui` — this file's props do not change, and roving-focus arrow-key
 * navigation between items is the one thing that comes back with it.
 */
export interface CanvasMenuTarget {
  readonly x: number;
  readonly y: number;
  /** null when the pointer was on empty canvas rather than on a card. */
  readonly entityId: Id | null;
}

export interface CanvasMenuItem {
  readonly id: string;
  readonly label: string;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}

export function CanvasMenu({
  target,
  items,
  onClose,
}: {
  readonly target: CanvasMenuTarget | null;
  readonly items: readonly CanvasMenuItem[];
  readonly onClose: () => void;
}) {
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
      <PopoverContent align="start" side="bottom" sideOffset={2} className="w-52 p-1">
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                disabled={item.disabled === true}
                className="w-full rounded px-2 py-1.5 text-left text-sm text-text hover:bg-surface-hover disabled:text-text-subtle"
                onClick={() => {
                  item.onSelect();
                  onClose();
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
