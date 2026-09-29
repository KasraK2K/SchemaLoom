'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button, buttonVariants, cn } from '@schemaloom/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { useForm, type FieldError } from 'react-hook-form';
import { z } from 'zod';
import { clientEnv } from '@/env.client';
import { ApiError, apiFetch, apiUrl } from '@/lib/api-client';
import {
  afterFirstFactor,
  fetchOAuthProviders,
  requestMagicLink,
  safeNextPath,
  signIn,
  signUp,
  type OAuthProviders,
} from './auth-api';

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
export function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'invalid_credentials':
        // Deliberately does not say WHICH was wrong — that would confirm an account
        // exists, which is an enumeration oracle.
        return 'That email and password do not match.';
      case 'email_taken':
        return 'An account with that email already exists.';
      case 'invalid_code':
        return 'That code is not right. Codes change every 30 seconds.';
      case 'token_invalid':
        return 'That link has expired or was already used. Ask for a new one.';
      case 'mfa_challenge_invalid':
        return 'That sign-in took too long. Start again.';
      case 'rate_limited':
      case 'too_many_requests':
        return 'Too many attempts. Wait a moment and try again.';
      default:
        return error.message;
    }
  }
  if (error instanceof TypeError) {
    // fetch() rejects with TypeError when the request never completes: the API is down,
    // OR the browser blocked it (CORS from a different origin, an extension, a stale
    // service worker). The browser does not say which, so the message names both.
    return `Cannot reach the API at ${clientEnv.NEXT_PUBLIC_API_URL}. If it is running, something in this browser is blocking it — try a private window.`;
  }
  return 'Something went wrong. Try again.';
}

export function AuthForm({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const isSignUp = mode === 'sign-up';
  const params = useSearchParams();
  const [formError, setFormError] = useState<string | null>(null);
  const [linkSentTo, setLinkSentTo] = useState<string | null>(null);

  // `?expired=1` means a Server Component hit a 401 it could not refresh itself. The
  // refresh token usually still works, so spend it here and go straight back; only a
  // dead refresh token leaves the user on this form.
  const expired = params.get('expired') === '1';
  useEffect(() => {
    if (!expired) return;
    apiFetch('/auth/refresh', { method: 'POST' })
      .then(() => {
        window.location.replace(safeNextPath(params.get('next')));
      })
      .catch(() => {
        setFormError('Your session expired. Sign in again.');
      });
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
      let destination = safeNextPath(params.get('next'));
      if (isSignUp) {
        await signUp({ email: values.email, password: values.password, name: values.name });
      } else {
        destination = afterFirstFactor(
          await signIn(values.email, values.password),
          params.get('next'),
        );
      }
      // A FULL navigation, not router.push: the API just set `sl_presence` on this
      // domain and the Next middleware has to see it. A client-side push can re-run
      // middleware against a request the browser built before the Set-Cookie landed,
      // which bounces straight back to /login and looks like a failed sign-in.
      window.location.assign(destination);
    } catch (error) {
      setFormError(messageFor(error));
    }
  });

  // Validates the email field alone: the password is irrelevant to a sign-in link.
  const sendLink = async () => {
    setFormError(null);
    if (!(await form.trigger('email'))) return;
    const email = form.getValues('email');
    try {
      await requestMagicLink(email, safeNextPath(params.get('next')));
      setLinkSentTo(email);
    } catch (error) {
      setFormError(messageFor(error));
    }
  };

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

      {linkSentTo !== null && (
        <p role="status" className="rounded-md bg-surface-sunken px-3 py-2 text-sm text-text">
          If {linkSentTo} can sign in, a link is on its way. It works once, for 15 minutes.
        </p>
      )}

      <Button type="submit" disabled={isSubmitting} className="mt-1">
        {isSubmitting ? 'Working…' : isSignUp ? 'Create account' : 'Sign in'}
      </Button>

      {!isSignUp && (
        <Button type="button" variant="outline" onClick={() => void sendLink()}>
          Email me a sign-in link
        </Button>
      )}

      <OAuthButtons />

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

const PROVIDER_LABELS: Record<keyof OAuthProviders, string> = {
  google: 'Continue with Google',
  github: 'Continue with GitHub',
};

/**
 * Drawn only for the providers the API has credentials for — an unconfigured provider's
 * route is a 404, so a button for it would be a dead end. Plain links: OAuth is a
 * top-level navigation to the API, which redirects back here when it is done.
 */
function OAuthButtons() {
  const [providers, setProviders] = useState<OAuthProviders | null>(null);
  useEffect(() => {
    fetchOAuthProviders()
      .then(setProviders)
      .catch(() => {
        setProviders(null);
      });
  }, []);
  if (providers === null) return null;
  const enabled = (Object.keys(PROVIDER_LABELS) as (keyof OAuthProviders)[]).filter(
    (p) => providers[p],
  );
  if (enabled.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {enabled.map((provider) => (
        <a
          key={provider}
          href={apiUrl(`/auth/${provider}`)}
          className={buttonVariants({ variant: 'outline' })}
        >
          {PROVIDER_LABELS[provider]}
        </a>
      ))}
    </div>
  );
}
