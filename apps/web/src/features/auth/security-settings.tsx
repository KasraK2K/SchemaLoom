'use client';

import { Button } from '@schemaloom/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { relativeTime } from '@/features/projects/relative-time';
import { messageFor } from './auth-form';
import {
  confirmTwoFactor,
  disableTwoFactor,
  enrolTwoFactor,
  fetchMe,
  listSessions,
  regenerateRecoveryCodes,
  revokeOtherSessions,
  revokeSession,
  type Enrolment,
} from './security-api';

const ME_KEY = ['auth', 'me'] as const;
const SESSIONS_KEY = ['auth', 'sessions'] as const;

export function SecuritySettings() {
  return (
    <div className="flex flex-col gap-10">
      <TwoFactorSection />
      <SessionsSection />
    </div>
  );
}

function TextInput({
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => { onChange(e.target.value); }}
        className="max-w-xs rounded-md border border-border bg-surface px-3 py-2 text-sm text-text"
      />
    </div>
  );
}

function ErrorLine({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  return (
    <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-text">
      {messageFor(error)}
    </p>
  );
}

/** Shown once, straight from the confirm/regenerate response. The API keeps only hashes. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-4">
      <p className="text-sm text-text">
        Save these recovery codes somewhere safe. Each works once, in place of a code from your
        app. They will not be shown again.
      </p>
      <ul className="grid grid-cols-2 gap-1 font-mono text-sm text-text">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <Button variant="outline" className="self-start" onClick={onDone}>
        I have saved them
      </Button>
    </div>
  );
}

function TwoFactorSection() {
  const queryClient = useQueryClient();
  const { data: me } = useQuery({ queryKey: ME_KEY, queryFn: fetchMe });
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');

  const refreshMe = () => queryClient.invalidateQueries({ queryKey: ME_KEY });
  const done = (next: string[]) => {
    setCodes(next);
    setEnrolment(null);
    setCode('');
    void refreshMe();
  };

  const enrol = useMutation({ mutationFn: enrolTwoFactor, onSuccess: setEnrolment });
  const confirm = useMutation({ mutationFn: () => confirmTwoFactor(code.trim()), onSuccess: done });
  const regenerate = useMutation({
    mutationFn: () => regenerateRecoveryCodes(code.trim()),
    onSuccess: done,
  });
  const disable = useMutation({
    mutationFn: () =>
      disableTwoFactor(code.trim() !== '' ? { code: code.trim() } : { password }),
    onSuccess: () => {
      setCode('');
      setPassword('');
      void refreshMe();
    },
  });

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-text">Two-factor authentication</h2>
        <p className="mt-1 text-sm text-text-muted">
          {me?.twoFactorEnabled === true
            ? 'On. Signing in asks for a code from your authenticator app.'
            : 'Off. Add a code from an authenticator app to every sign-in.'}
        </p>
      </div>

      {codes !== null && <RecoveryCodes codes={codes} onDone={() => { setCodes(null); }} />}

      {me?.twoFactorEnabled === false && enrolment === null && (
        <Button className="self-start" disabled={enrol.isPending} onClick={() => { enrol.mutate(); }}>
          Set up two-factor
        </Button>
      )}

      {me?.twoFactorEnabled === false && enrolment !== null && (
        // ponytail: no QR code yet — the otpauth:// link opens authenticator apps on
        // mobile and the secret covers manual entry; render a QR when a client lib lands.
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text">
            Add SchemaLoom to your authenticator app with{' '}
            <a href={enrolment.otpauthUri} className="text-accent-text underline underline-offset-2">
              this link
            </a>{' '}
            or by entering the key below, then type the code it shows.
          </p>
          <code className="self-start rounded bg-surface-sunken px-2 py-1 font-mono text-sm break-all text-text">
            {enrolment.secret}
          </code>
          <TextInput label="Code" value={code} onChange={setCode} autoComplete="one-time-code" />
          <ErrorLine error={confirm.error} />
          <Button
            className="self-start"
            disabled={confirm.isPending || code.trim() === ''}
            onClick={() => { confirm.mutate(); }}
          >
            Turn on
          </Button>
        </div>
      )}

      {me?.twoFactorEnabled === true && (
        <div className="flex flex-col gap-3">
          <TextInput
            label="Current code or recovery code"
            value={code}
            onChange={setCode}
            autoComplete="one-time-code"
          />
          <TextInput
            label="Or your password (to turn off only)"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />
          <ErrorLine error={regenerate.error ?? disable.error} />
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={regenerate.isPending || code.trim() === ''}
              onClick={() => { regenerate.mutate(); }}
            >
              New recovery codes
            </Button>
            <Button
              variant="danger"
              disabled={disable.isPending || (code.trim() === '' && password === '')}
              onClick={() => { disable.mutate(); }}
            >
              Turn off
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function SessionsSection() {
  const queryClient = useQueryClient();
  const { data: sessions } = useQuery({ queryKey: SESSIONS_KEY, queryFn: listSessions });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
  const revoke = useMutation({ mutationFn: revokeSession, onSuccess: invalidate });
  const revokeOthers = useMutation({ mutationFn: revokeOtherSessions, onSuccess: invalidate });

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-text">Signed-in devices</h2>
        <p className="mt-1 text-sm text-text-muted">
          Signing a device out takes effect within 15 minutes, when its access token expires.
        </p>
      </div>
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {(sessions ?? []).map((s) => (
          <li key={s.familyId} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-text">{s.userAgent ?? 'Unknown device'}</p>
              <p className="text-xs text-text-muted">
                {s.ip ?? 'unknown IP'} · signed in {relativeTime(s.signedInAt)} · active{' '}
                {relativeTime(s.lastActiveAt)}
              </p>
            </div>
            {s.current ? (
              <span className="text-xs font-medium text-text-muted">This device</span>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={revoke.isPending}
                onClick={() => { revoke.mutate(s.familyId); }}
              >
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
      <ErrorLine error={revoke.error ?? revokeOthers.error} />
      <Button
        variant="outline"
        className="self-start"
        disabled={revokeOthers.isPending || (sessions ?? []).every((s) => s.current)}
        onClick={() => { revokeOthers.mutate(); }}
      >
        Sign out all other devices
      </Button>
    </section>
  );
}
