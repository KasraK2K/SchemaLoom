'use client';

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { type ButtonHTMLAttributes } from 'react';
import { cn } from './cn.js';

/**
 * Exported separately from the component so a Radix `asChild` target (a link, a
 * DropdownMenu.Trigger) can wear button styling without nesting a <button>.
 *
 * No focus-ring utilities here: `theme.css` puts a two-tone ring on
 * `:where(:focus-visible)` globally, so every focusable element gets one and none of
 * them can forget it.
 */
export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-on-accent hover:bg-accent-hover',
        secondary: 'bg-surface-sunken text-text hover:bg-surface-hover',
        outline: 'border border-border bg-surface text-text hover:bg-surface-hover',
        ghost: 'text-text-muted hover:bg-surface-hover hover:text-text',
        danger: 'bg-danger text-on-accent hover:brightness-110',
      },
      size: {
        sm: 'h-7 px-2 text-xs',
        md: 'h-9 px-3 text-sm',
        lg: 'h-11 px-5 text-base',
        icon: 'size-9',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Render the child element instead of a <button>, keeping the styling. */
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Component = asChild ? Slot : 'button';
  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
