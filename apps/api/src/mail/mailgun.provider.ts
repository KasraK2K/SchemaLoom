import type { EmailMessage, EmailProvider } from './email-provider';

/**
 * Bound when `MAILGUN_API_KEY` and `MAILGUN_DOMAIN` are set. Mailgun's HTTP API is one
 * form-encoded POST, so this is `fetch` rather than a client library.
 * `MAILGUN_API_URL` is `https://api.eu.mailgun.net` for a domain in Mailgun's EU region.
 */
export class MailgunEmailProvider implements EmailProvider {
  constructor(
    private readonly apiKey: string,
    private readonly domain: string,
    private readonly from: string,
    private readonly apiUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const url = `${this.apiUrl.replace(/\/+$/, '')}/v3/${encodeURIComponent(this.domain)}/messages`;
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`api:${this.apiKey}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    // A refusal is a status code, not a rejected promise. Swallowing it would make
    // "password reset sent" a lie the user cannot act on.
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      throw new Error(`Mailgun refused the message: ${String(response.status)} ${detail}`);
    }
  }
}
