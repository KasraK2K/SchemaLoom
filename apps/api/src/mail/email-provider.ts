/**
 * `MAILGUN_API_KEY` + `MAILGUN_DOMAIN` present -> Mailgun; otherwise `SMTP_URL` (mailpit
 * locally). `env.ts` already refuses to boot when both are missing, so this interface
 * always has exactly one implementation bound behind it.
 *
 * Two implementations is why this is an interface rather than a concrete class — the
 * local loop must not need a Mailgun account and production must not need an SMTP relay.
 */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

/** DI token — `EmailProvider` is a type, so it cannot be one itself. */
export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';
