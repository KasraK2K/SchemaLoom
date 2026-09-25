'use client';

import type { ResourceType } from '@schemaloom/contracts';
import { Button } from '@schemaloom/ui';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { requestAccess } from './sharing-api';

/**
 * "Request access" — §7.13, the requester half.
 *
 * Mounted on a restricted stub as well as on a 404 shell: a stub carries its REAL id
 * (RECONCILIATION R-2), so the faded node on the canvas is exactly where this button
 * goes and the id it holds is the id this endpoint takes.
 *
 * The endpoint returns `202` unconditionally — for a project that does not exist, one in
 * another org, or one you already hold — precisely so it cannot be used to enumerate
 * projects. So this renders one outcome for every response. Distinguishing them in the UI
 * would hand back the oracle the API just closed.
 */
export function RequestAccessButton({
  projectId,
  resourceType,
  resourceId,
  className,
}: {
  readonly projectId: string;
  readonly resourceType: ResourceType;
  readonly resourceId: string;
  readonly className?: string;
}) {
  const [message, setMessage] = useState('');
  const request = useMutation({
    mutationFn: () => requestAccess({ projectId, resourceType, resourceId, message }),
  });

  if (request.isSuccess) {
    return (
      <p className={className} role="status">
        Request sent. You will hear back once someone reviews it.
      </p>
    );
  }

  return (
    <div className={className}>
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        Why do you need access? (optional)
        <input
          type="text"
          className="h-8 rounded-md border border-border bg-surface px-2 text-sm text-text"
          value={message}
          onChange={(event) => {
            setMessage(event.target.value);
          }}
        />
      </label>
      <Button
        size="sm"
        className="mt-2"
        disabled={request.isPending}
        onClick={() => {
          request.mutate();
        }}
      >
        Request access
      </Button>
    </div>
  );
}
