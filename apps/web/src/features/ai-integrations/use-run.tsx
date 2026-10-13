import { useState } from 'react';
import { orgAdminMessage } from '@/features/org-settings/messages';

export const INPUT = 'h-8 rounded-md border border-border bg-surface px-2 text-sm text-text';

export interface Notice {
  readonly text: string;
  readonly error: boolean;
}

/** `busy`/`message` state around a write, as `audit-stream.tsx` does inline. */
export function useRun(after: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Notice | null>(null);
  const run = async (write: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setMessage(null);
    try {
      await write();
      await after();
      return true;
    } catch (caught) {
      setMessage({ text: orgAdminMessage(caught), error: true });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, message, setMessage, run };
}

export function Message({ message }: { readonly message: Notice | null }) {
  if (message === null) return null;
  return (
    <p
      role={message.error ? 'alert' : 'status'}
      className={`text-sm ${message.error ? 'text-danger-text' : 'text-text'}`}
    >
      {message.text}
    </p>
  );
}
