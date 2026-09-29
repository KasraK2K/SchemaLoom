import { createTransport, type Transporter } from 'nodemailer';
import type { EmailMessage, EmailProvider } from './email-provider';

/** Bound when Mailgun is not configured. Locally `smtp://localhost:1025` (mailpit). */
export class SmtpEmailProvider implements EmailProvider {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = createTransport(smtpUrl);
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}
