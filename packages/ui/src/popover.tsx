'use client';

import * as PopoverPrimitive from '@radix-ui/react-popover';
import { type ComponentProps } from 'react';
import { cn } from './cn.js';
import { floatingSurface } from './styles.js';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export function PopoverContent({
  className,
  align = 'center',
  sideOffset = 6,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(floatingSurface, 'w-72 p-3 text-sm', className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
