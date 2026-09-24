import { Resend } from 'resend';
import type { EmailMessage, EmailProvider } from './email-provider';

/** Bound when `RESEND_API_KEY` is set (doc 01 §11.1). */
export class ResendEmailProvider implements EmailProvider {
  private readonly client: Resend;

  constructor(
    apiKey: string,
    private readonly from: string,
  ) {
    this.client = new Resend(apiKey);
  }

  async send(message: EmailMessage): Promise<void> {
    const { error } = await this.client.emails.send({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    // Resend reports failures in the body, not by rejecting. Swallowing that would
    // make "password reset sent" a lie the user cannot act on.
    if (error) throw new Error(`Resend refused the message: ${error.message}`);
  }
}
