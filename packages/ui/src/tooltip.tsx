'use client';

import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { type ComponentProps } from 'react';
import { cn } from './cn.js';

/**
 * `TooltipProvider` belongs once, high in the tree — it owns the shared open/close
 * delay so moving between adjacent toolbar buttons does not re-pay the delay.
 *
 * A tooltip is never the only carrier of a control's accessible name: it is not
 * announced on a touch device and not reachable by keyboard-only users on some
 * screen readers. Icon-only buttons still need `aria-label`.
 */
export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 rounded-md border border-border bg-surface-raised px-2 py-1 text-xs text-text shadow-popover',
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}
