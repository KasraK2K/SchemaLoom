import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api-client';

/**
 * One client per browser session, created inside a `useState` initialiser so a
 * Strict-Mode double render or a fast refresh does not hand two components two
 * different caches.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // 401/403/404 are answers, not outages. Retrying them burns three requests to
        // reach the same conclusion and delays the redirect to /login.
        retry: (failureCount, error) =>
          error instanceof ApiError && error.status < 500 ? false : failureCount < 2,
      },
      mutations: { retry: false },
    },
  });
}
