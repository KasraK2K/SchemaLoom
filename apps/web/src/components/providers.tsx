'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider, ToastViewport, TooltipProvider } from '@schemaloom/ui';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { ThemeProvider } from '@/components/theme-provider';
import { makeQueryClient } from '@/lib/query-client';

/**
 * The single client boundary at the top of the (app) tree. Everything below it that
 * needs a hook gets one from here; everything that does not stays a Server Component.
 *
 * `EngineUiProvider` joins this list at build-order step 25, when there is an engine
 * UI plugin to register.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider delayDuration={300} skipDelayDuration={300}>
          <ToastProvider swipeDirection="right">
            {children}
            <ToastViewport />
          </ToastProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
