// A stand-in for the Anthropic Messages API, so the AI panel runs end to end without a key.
// The e2e api points `ANTHROPIC_BASE_URL` here (the SDK reads it); the production code is
// unchanged. Every request body is kept, and `GET /calls` returns them, so a test can check
// exactly what left the api. The answer is always the same Code-mode answer over the seed's
// `orders` and `customers`.
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

const calls: unknown[] = [];

const sse = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/calls') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(calls));
    return;
  }
  if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk.toString()));
  req.on('end', () => {
    calls.push(JSON.parse(body));
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
    const half = Math.floor(ANSWER.length / 2);
    for (const text of [ANSWER.slice(0, half), ANSWER.slice(half)]) {
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
