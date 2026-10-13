// A stand-in for the Anthropic Messages API and for an OpenAI-compatible server (/v1/models,
// /v1/chat/completions), so the AI panel runs end to end without a key.
// The e2e api points `ANTHROPIC_BASE_URL` here (the SDK reads it); the production code is
// unchanged. Every request body is kept, and `GET /calls` returns them, so a test can check
// exactly what left the api. The answer is the same Code-mode answer over the seed's
// `orders` and `customers`, except for draft-schema requests (below).
import { createServer } from 'node:http';

const PORT = Number(process.env.FAKE_ANTHROPIC_PORT ?? 3009);

const ANSWER = [
  '<code>',
  'const rows = await prisma.orders.findMany({',
  '  where: { total_cents: { gt: 10000 } },',
  '  select: { id: true, customers: { select: { email: true } } },',
  '});',
  '</code>',
  '<query>',
  'SELECT o.id, c.email FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.total_cents > 10000',
  '</query>',
  '<explanation>',
  'Orders over $100 with the email of the customer who placed them.',
  '</explanation>',
  '<assumptions>',
  '- total_cents holds the amount in cents',
  '</assumptions>',
].join('\n');

// Phase 22 — draft-schema requests (their instructions ask for `<ddl>`) get invoices that
// reference the project's existing `customers`. A revise (draft sent back as the model's
// own turn) adds a status column, and a column on `customers`. The draft names its area (Phase 22b Q2).
const invoices = (status: boolean): string =>
  [
    '<ddl>',
    '-- area: Billing',
    'CREATE TABLE invoices (',
    '  id uuid PRIMARY KEY,',
    '  customer_id uuid NOT NULL,',
    '  total_cents bigint NOT NULL,',
    ...(status ? ["  status text NOT NULL DEFAULT 'open',"] : []),
    '  CONSTRAINT invoices_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT',
    ');',
    "COMMENT ON TABLE invoices IS 'One row per invoice';",
    ...(status ? ['ALTER TABLE customers ADD COLUMN billing_email text;'] : []),
    '</ddl>',
  ].join('\n');

const answerFor = (body: { system?: unknown; messages?: unknown[] }): string =>
  JSON.stringify(body.system ?? '').includes('<ddl>')
    ? invoices((body.messages?.length ?? 0) > 1)
    : ANSWER;

const calls: unknown[] = [];

const sse = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/calls') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(calls));
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-chat', object: 'model' }] }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const request = JSON.parse(raw) as { messages?: { role: string; content: string }[] };
      calls.push({ openai: true, ...request });
      const answer = JSON.stringify(request.messages ?? []).includes('<ddl>')
        ? invoices(false)
        : ANSWER;
      const chunk = (delta: object, finish: string | null): string =>
        `data: ${JSON.stringify({ id: 'cc_fake', object: 'chat.completion.chunk', model: 'fake-chat', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const half = Math.floor(answer.length / 2);
      res.write(chunk({ role: 'assistant', content: answer.slice(0, half) }, null));
      res.write(chunk({ content: answer.slice(half) }, 'stop'));
      res.write(
        `data: ${JSON.stringify({ id: 'cc_fake', object: 'chat.completion.chunk', model: 'fake-chat', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
    return;
  }
  if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk.toString()));
  req.on('end', () => {
    const request = JSON.parse(body) as { system?: unknown; messages?: unknown[] };
    calls.push(request);
    const answer = answerFor(request);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      sse('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_e2e_fake',
          type: 'message',
          role: 'assistant',
          model: 'e2e-fake',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
    );
    res.write(
      sse('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    );
    // Two deltas, so the panel's streaming path runs and not just the final message.
    const half = Math.floor(answer.length / 2);
    for (const text of [answer.slice(0, half), answer.slice(half)]) {
      res.write(
        sse('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        }),
      );
    }
    res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
    res.write(
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      }),
    );
    res.end(sse('message_stop', { type: 'message_stop' }));
  });
}).listen(PORT, '127.0.0.1');
