import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../config/env';
import { EMAIL_PROVIDER, type EmailProvider } from './email-provider';
import { MailService } from './mail.service';
import { ResendEmailProvider } from './resend.provider';
import { SmtpEmailProvider } from './smtp.provider';

/**
 * Exported so the binding rule is testable without a container: doc 01 §11.1 says
 * Resend wins when its key is present, and `env.ts` guarantees the `SMTP_URL`
 * fallback exists otherwise — hence the `?? ''` is unreachable, not a silent default.
 */
export function createEmailProvider(config: ConfigService<AppEnv, true>): EmailProvider {
  const from: string = config.get('MAIL_FROM', { infer: true });
  const resendKey: string | undefined = config.get('RESEND_API_KEY', { infer: true });
  if (resendKey) return new ResendEmailProvider(resendKey, from);
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
