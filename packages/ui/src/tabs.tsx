'use client';

import * as TabsPrimitive from '@radix-ui/react-tabs';
import { type ComponentProps } from 'react';
import { cn } from './cn.js';

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('flex items-center gap-1 border-b border-border px-2', className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        // The active tab is marked by an underline AND a text-colour change: colour
        // alone would fail WCAG 1.4.1.
        '-mb-px border-b-2 border-transparent px-2 py-1.5 text-sm text-text-muted transition-colors hover:text-text data-[state=active]:border-accent data-[state=active]:font-medium data-[state=active]:text-text',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('p-3', className)} {...props} />;
}
