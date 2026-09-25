'use client';

import * as ToastPrimitive from '@radix-ui/react-toast';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import { type ComponentProps } from 'react';
import { cn } from './cn.js';

/**
 * Radix owns the live-region announcement, the swipe gesture and the F8 hotkey that
 * moves focus into the toast — the parts a hand-rolled toast always gets wrong.
 * `ToastProvider` + `ToastViewport` are mounted once by the app's Providers.
 */
export const ToastProvider = ToastPrimitive.Provider;
export const ToastAction = ToastPrimitive.Action;

export function ToastViewport({
  className,
  ...props
}: ComponentProps<typeof ToastPrimitive.Viewport>) {
  return (
    <ToastPrimitive.Viewport
      className={cn(
        'fixed right-0 bottom-0 z-100 flex max-h-screen w-full flex-col-reverse gap-2 p-4 sm:max-w-sm',
        className,
      )}
      {...props}
    />
  );
}

const toastVariants = cva(
  'flex items-start gap-3 rounded-md border p-3 text-sm shadow-popover data-[state=closed]:opacity-0',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-surface-raised text-text',
        success: 'border-success bg-success-subtle text-success-text',
        warning: 'border-warning bg-warning-subtle text-warning-text',
        danger: 'border-danger bg-danger-subtle text-danger-text',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface ToastProps
  extends ComponentProps<typeof ToastPrimitive.Root>,
    VariantProps<typeof toastVariants> {}

export function Toast({ className, tone, ...props }: ToastProps) {
  return <ToastPrimitive.Root className={cn(toastVariants({ tone }), className)} {...props} />;
}

export function ToastTitle({ className, ...props }: ComponentProps<typeof ToastPrimitive.Title>) {
  return <ToastPrimitive.Title className={cn('font-medium', className)} {...props} />;
}

export function ToastDescription({
  className,
  ...props
}: ComponentProps<typeof ToastPrimitive.Description>) {
  return (
    <ToastPrimitive.Description className={cn('mt-0.5 text-text-muted', className)} {...props} />
  );
}

export function ToastClose({ className, ...props }: ComponentProps<typeof ToastPrimitive.Close>) {
  return (
    <ToastPrimitive.Close
      aria-label="Dismiss"
      className={cn('ml-auto rounded-sm p-0.5 text-text-subtle hover:text-text', className)}
      {...props}
    >
      <X className="size-4" aria-hidden="true" />
    </ToastPrimitive.Close>
  );
}
