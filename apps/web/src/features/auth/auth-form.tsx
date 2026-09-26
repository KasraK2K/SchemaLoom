'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button, cn } from '@schemaloom/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { useForm, type FieldError } from 'react-hook-form';
import { z } from 'zod';
import { ApiError, apiFetch } from '@/lib/api-client';
import { safeNextPath, signIn, signUp } from './auth-api';

/**
 * One component for both sign-in and sign-up. They differ by one field and one endpoint;
 * two near-identical files would drift on the error handling, which is the part worth
 * getting right once.
 */

/**
 * Both modes share ONE field shape, so both resolvers infer the same `FormValues` and
 * neither needs a cast. Sign-in simply does not render `name` and does not validate it.
 */
const baseSchema = z.object({
  name: z.string(),
  email: z.email('That does not look like an email').min(1, 'Enter your email'),
  password: z.string().min(1, 'Enter your password'),
});

const signUpSchema = baseSchema.extend({
  name: z.string().min(1, 'Enter your name'),
  // The API hashes with argon2id and enforces its own floor; this is the client-side
  // courtesy check, not the security boundary.
  password: z.string().min(12, 'Use at least 12 characters'),
});

type FormValues = z.infer<typeof baseSchema>;

interface FieldProps {
  label: string;
  type: string;
  autoComplete: string;
  error: FieldError | undefined;
  registration: ReturnType<ReturnType<typeof useForm>['register']>;
}

function Field({ label, type, autoComplete, error, registration }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      <input
        id={id}
        type={type}
        autoComplete={autoComplete}
        // The message is bound by aria-describedby AND aria-invalid: a red border alone
        // is colour-only feedback and fails WCAG AA on its own.
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : errorId}
        className={cn(
          'rounded-md border bg-surface px-3 py-2 text-sm text-text',
          'placeholder:text-text-subtle',
          error === undefined ? 'border-border' : 'border-danger',
        )}
        {...registration}
      />
      {error !== undefined && (
        <p id={errorId} className="text-xs text-danger-text">
          {error.message}
        </p>
      )}
    </div>
  );
}

/** What the user should actually read when the API refuses. */
function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'invalid_credentials':
        // Deliberately does not say WHICH was wrong — that would confirm an account
        // exists, which is an enumeration oracle.
        return 'That email and password do not match.';
      case 'email_taken':
        return 'An account with that email already exists.';
      case 'rate_limited':
        return 'Too many attempts. Wait a moment and try again.';
      default:
        return error.message;
    }
  }
  if (error instanceof TypeError) {
    // fetch() rejects with TypeError when it cannot reach the host at all.
    return 'Cannot reach the API. Is it running on port 3001?';
  }
  return 'Something went wrong. Try again.';
}

export function AuthForm({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const isSignUp = mode === 'sign-up';
  const params = useSearchParams();
  const [formError, setFormError] = useState<string | null>(null);

  // `?expired=1` means a Server Component hit a 401 it could not refresh itself. The
  // refresh token usually still works, so spend it here and go straight back; only a
  // dead refresh token leaves the user on this form.
  const expired = params.get('expired') === '1';
  useEffect(() => {
    if (!expired) return;
    apiFetch('/auth/refresh', { method: 'POST' })
      .then(() => { window.location.replace(safeNextPath(params.get('next'))); })
      .catch(() => { setFormError('Your session expired. Sign in again.'); });
  }, [expired, params]);

  const form = useForm<FormValues>({
    resolver: zodResolver(isSignUp ? signUpSchema : baseSchema),
    defaultValues: { email: '', password: '', name: '' },
  });

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = form;

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      if (isSignUp) {
        await signUp({ email: values.email, password: values.password, name: values.name });
      } else {
        await signIn(values.email, values.password);
      }
      // A FULL navigation, not router.push: the API just set `sl_presence` on this
      // domain and the Next middleware has to see it. A client-side push can re-run
      // middleware against a request the browser built before the Set-Cookie landed,
      // which bounces straight back to /login and looks like a failed sign-in.
      window.location.assign(safeNextPath(params.get('next')));
    } catch (error) {
      setFormError(messageFor(error));
    }
  });

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="mt-6 flex flex-col gap-4" noValidate>
      {isSignUp && (
        <Field
          label="Name"
          type="text"
          autoComplete="name"
          error={errors.name}
          registration={register('name')}
        />
      )}
      <Field
        label="Email"
        type="email"
        autoComplete="email"
        error={errors.email}
        registration={register('email')}
      />
      <Field
        label="Password"
        type="password"
        autoComplete={isSignUp ? 'new-password' : 'current-password'}
        error={errors.password}
        registration={register('password')}
      />

      {formError !== null && (
        // role="alert" so a screen reader hears the refusal; without it the form simply
        // appears not to have submitted.
        <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-text">
          {formError}
        </p>
      )}

      <Button type="submit" disabled={isSubmitting} className="mt-1">
        {isSubmitting ? 'Working…' : isSignUp ? 'Create account' : 'Sign in'}
      </Button>

      <p className="text-sm text-text-muted">
        {isSignUp ? 'Already have an account? ' : 'No account yet? '}
        <Link
          href={isSignUp ? '/login' : '/signup'}
          className="text-accent-text underline underline-offset-2"
        >
          {isSignUp ? 'Sign in' : 'Create one'}
        </Link>
      </p>
    </form>
  );
}
