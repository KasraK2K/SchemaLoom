import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../config/env';
import { EMAIL_PROVIDER, type EmailProvider } from './email-provider';

/** Minimal escaping — the only interpolations are a URL we built and a user's name. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function layout(heading: string, body: string, actionUrl: string, actionLabel: string): string {
  return [
    `<p>${escapeHtml(heading)}</p>`,
    `<p>${escapeHtml(body)}</p>`,
    `<p><a href="${escapeHtml(actionUrl)}">${escapeHtml(actionLabel)}</a></p>`,
    `<p>${escapeHtml(actionUrl)}</p>`,
  ].join('\n');
}

/**
 * The two Phase 1 transactional emails. Magic-link and invitation mail attach here in
 * later steps — same provider, one more method each.
 *
 * Every link points at `WEB_PUBLIC_URL` (doc 01 §11.1), never at the API: the token is
 * consumed by an SPA route that POSTs it back, so a mail-scanner prefetching the link
 * cannot burn a single-use token with a GET.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    @Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  private link(path: string, token: string): string {
    const base = this.config.get('WEB_PUBLIC_URL', { infer: true }).replace(/\/+$/, '');
    return `${base}${path}?token=${encodeURIComponent(token)}`;
  }

  async sendVerificationEmail(to: string, name: string, token: string): Promise<void> {
    const url = this.link('/verify-email', token);
    await this.send({
      to,
      subject: 'Verify your SchemaLoom email address',
      text: `Hi ${name},\n\nConfirm this address to finish setting up your SchemaLoom account:\n${url}\n\nThe link expires in 24 hours.`,
      html: layout(
        `Hi ${name},`,
        'Confirm this address to finish setting up your SchemaLoom account. The link expires in 24 hours.',
        url,
        'Verify email address',
      ),
    });
  }

  async sendPasswordResetEmail(to: string, name: string, token: string): Promise<void> {
    const url = this.link('/reset-password', token);
    await this.send({
      to,
      subject: 'Reset your SchemaLoom password',
      text: `Hi ${name},\n\nReset your SchemaLoom password:\n${url}\n\nThe link expires in 1 hour. If you did not ask for this, ignore this email — nothing has changed.`,
      html: layout(
        `Hi ${name},`,
        'Reset your SchemaLoom password. The link expires in 1 hour. If you did not ask for this, ignore this email — nothing has changed.',
        url,
        'Reset password',
      ),
    });
  }

  /** No name: the address may not belong to an account yet. */
  async sendMagicLinkEmail(to: string, token: string, next?: string): Promise<void> {
    const url =
      this.link('/magic-link', token) +
      (next === undefined ? '' : `&next=${encodeURIComponent(next)}`);
    await this.send({
      to,
      subject: 'Your SchemaLoom sign-in link',
      text: `Sign in to SchemaLoom:\n${url}\n\nThe link works once and expires in 15 minutes. If you did not ask for this, ignore this email.`,
      html: layout(
        'Hi,',
        'Sign in to SchemaLoom. The link works once and expires in 15 minutes. If you did not ask for this, ignore this email.',
        url,
        'Sign in',
      ),
    });
  }

  /** Doc 05 §6.4 (R11). The page GETs the invite and POSTs the accept once signed in. */
  async sendInvitationEmail(
    to: string,
    inviterName: string,
    orgName: string,
    token: string,
  ): Promise<void> {
    const base = this.config.get('WEB_PUBLIC_URL', { infer: true }).replace(/\/+$/, '');
    const url = `${base}/invite/${encodeURIComponent(token)}`;
    const body = `${inviterName} shared a schema in ${orgName} with you on SchemaLoom. The invitation expires in 7 days.`;
    await this.send({
      to,
      subject: `${inviterName} invited you to ${orgName} on SchemaLoom`,
      text: `Hi,\n\n${body}\n${url}`,
      html: layout('Hi,', body, url, 'Open the invitation'),
    });
  }

  /** Roadmap 16: an org invite from Settings → Members. The link creates the account too. */
  async sendMemberInvitationEmail(
    to: string,
    inviterName: string,
    orgName: string,
    token: string,
  ): Promise<void> {
    const base = this.config.get('WEB_PUBLIC_URL', { infer: true }).replace(/\/+$/, '');
    const url = `${base}/invite/${encodeURIComponent(token)}`;
    const body = `${inviterName} invited you to join ${orgName} on SchemaLoom. The invitation expires in 7 days.`;
    await this.send({
      to,
      subject: `${inviterName} invited you to ${orgName} on SchemaLoom`,
      text: `Hi,\n\n${body}\n${url}`,
      html: layout('Hi,', body, url, 'Accept the invitation'),
    });
  }

  /**
   * Phase 4 §4 — one in-app notification, mirrored by email when the recipient's pref is
   * on. `title` is templated from ids (doc 05 L7/L17) and never quotes schema text.
   */
  async sendNotificationEmail(
    to: string,
    name: string,
    title: string,
    path: string | null,
  ): Promise<void> {
    const base = this.config.get('WEB_PUBLIC_URL', { infer: true }).replace(/\/+$/, '');
    const url = `${base}${path ?? '/'}`;
    await this.send({
      to,
      subject: title,
      text: `Hi ${name},\n\n${title}.\n${url}\n\nChange which emails you get under Account settings.`,
      html: layout(`Hi ${name},`, `${title}.`, url, 'Open SchemaLoom'),
    });
  }

  /**
   * A dead SMTP box must not 500 a registration that already committed. The token row
   * exists either way and "resend verification" is one click, so the failure is logged
   * and swallowed. Password reset is the same shape: the caller answers 204 regardless,
   * because answering differently is an account-enumeration oracle.
   */
  private async send(message: Parameters<EmailProvider['send']>[0]): Promise<void> {
    try {
      await this.provider.send(message);
    } catch (error) {
      this.logger.error({ err: error, subject: message.subject }, 'email delivery failed');
    }
  }
}
