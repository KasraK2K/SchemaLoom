import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../config/env';
import { EMAIL_PROVIDER, type EmailProvider } from './email-provider';
import { MailService } from './mail.service';
import { MailgunEmailProvider } from './mailgun.provider';
import { SmtpEmailProvider } from './smtp.provider';

/**
 * Exported so the binding rule is testable without a container: Mailgun wins when its key
 * and domain are set, and `env.ts` guarantees the `SMTP_URL` fallback exists otherwise —
 * hence the `?? ''` is unreachable, not a silent default.
 */
export function createEmailProvider(config: ConfigService<AppEnv, true>): EmailProvider {
  const from: string = config.get('MAIL_FROM', { infer: true });
  const mailgunKey: string | undefined = config.get('MAILGUN_API_KEY', { infer: true });
  const mailgunDomain: string | undefined = config.get('MAILGUN_DOMAIN', { infer: true });
  if (mailgunKey && mailgunDomain) {
    const apiUrl: string = config.get('MAILGUN_API_URL', { infer: true });
    return new MailgunEmailProvider(mailgunKey, mailgunDomain, from, apiUrl);
  }
  const smtpUrl: string | undefined = config.get('SMTP_URL', { infer: true });
  return new SmtpEmailProvider(smtpUrl ?? '', from);
}

@Module({
  providers: [
    { provide: EMAIL_PROVIDER, inject: [ConfigService], useFactory: createEmailProvider },
    MailService,
  ],
  exports: [MailService, EMAIL_PROVIDER],
})
export class MailModule {}
