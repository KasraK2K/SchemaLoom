import { describe, expect, it, vi } from 'vitest';
import { MailgunEmailProvider } from './mailgun.provider';

const MESSAGE = { to: 'ana@example.com', subject: 'Hi', text: 'plain', html: '<p>html</p>' };

describe('MailgunEmailProvider', () => {
  it('POSTs the message to the domain with Basic auth and form fields', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const provider = new MailgunEmailProvider(
      'key-123',
      'mg.example.com',
      'SchemaLoom <no-reply@mg.example.com>',
      'https://api.eu.mailgun.net/',
      fetchFn,
    );

    await provider.send(MESSAGE);

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.eu.mailgun.net/v3/mg.example.com/messages');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('api:key-123').toString('base64')}`,
    );
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      from: 'SchemaLoom <no-reply@mg.example.com>',
      ...MESSAGE,
    });
  });

  it('throws when Mailgun refuses, so the failure is logged rather than lost', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('Forbidden', { status: 401 }));
    const provider = new MailgunEmailProvider(
      'bad',
      'mg.example.com',
      'x@y',
      'https://api.mailgun.net',
      fetchFn,
    );
    await expect(provider.send(MESSAGE)).rejects.toThrow(
      /Mailgun refused the message: 401 Forbidden/,
    );
  });
});
