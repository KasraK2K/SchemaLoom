import { Injectable } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import type { EmailJobData } from './queues';

/**
 * Email off the request path.
 *
 * `MailService` already logs-and-swallows a delivery failure so a dead SMTP box cannot 500
 * a registration that already committed. That stays true here, and the queue adds the
 * thing a synchronous send cannot: a retry, on BullMQ's backoff, without the user waiting
 * on it.
 */
@Injectable()
export class EmailProcessor {
  constructor(private readonly mail: MailService) {}

  async run(data: EmailJobData): Promise<void> {
    switch (data.kind) {
      case 'verify-email':
        await this.mail.sendVerificationEmail(data.to, data.name, data.token);
        return;
      case 'password-reset':
        await this.mail.sendPasswordResetEmail(data.to, data.name, data.token);
        return;
    }
  }
}
