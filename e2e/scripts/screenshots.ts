// Captures the README screenshots into docs/screenshots/ from a running `pnpm dev`
// against the seeded DEV database (`pnpm db:seed`). Signs in as the seed owner and, on
// first run, imports a "Commerce platform" showcase project; later runs reuse it.
//
//   pnpm --filter @schemaloom/e2e screenshots
//
// The AI shot sends one real prompt, so it needs ANTHROPIC_API_KEY on the api.
import { chromium, request, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WEB = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const API = process.env.E2E_API_URL ?? 'http://localhost:3001';
const OUT = fileURLToPath(new URL('../../docs/screenshots/', import.meta.url));
const PROJECT = 'Commerce platform';

const SQL = `
CREATE TABLE customers (id uuid PRIMARY KEY, email citext NOT NULL UNIQUE, full_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE addresses (id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers (id), line1 text NOT NULL, city text NOT NULL, country char(2) NOT NULL);
CREATE TABLE categories (id uuid PRIMARY KEY, parent_id uuid REFERENCES categories (id), name text NOT NULL);
CREATE TABLE products (id uuid PRIMARY KEY, category_id uuid REFERENCES categories (id), sku varchar(64) NOT NULL UNIQUE, name text NOT NULL, list_price numeric(10,2) NOT NULL);
CREATE TABLE inventory (product_id uuid PRIMARY KEY REFERENCES products (id), on_hand integer NOT NULL DEFAULT 0, reserved integer NOT NULL DEFAULT 0);
CREATE TABLE orders (id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers (id), shipping_address_id uuid REFERENCES addresses (id), status text NOT NULL, total_cents integer NOT NULL, placed_at timestamptz NOT NULL);
CREATE TABLE order_items (id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders (id), product_id uuid NOT NULL REFERENCES products (id), quantity integer NOT NULL, unit_price numeric(10,2) NOT NULL);
CREATE TABLE payments (id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders (id), provider text NOT NULL, amount_cents integer NOT NULL, captured_at timestamptz);
CREATE TABLE shipments (id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders (id), carrier text NOT NULL, tracking_no text, shipped_at timestamptz);
CREATE TABLE reviews (id uuid PRIMARY KEY, product_id uuid NOT NULL REFERENCES products (id), customer_id uuid NOT NULL REFERENCES customers (id), rating smallint NOT NULL, body text);
`;

const settle = (page: Page, ms = 1500) => page.waitForTimeout(ms);
// Hides the Next.js dev badge; parks the mouse so the inspector rail is not hover-expanded.
const shot = async (page: Page, name: string) => {
  await page.mouse.move(700, 500);
  await settle(page, 500);
  await page.screenshot({
    path: `${OUT}${name}.png`,
    style: 'nextjs-portal { display: none !important; }',
  });
};

mkdirSync(OUT, { recursive: true });
const api = await request.newContext({ baseURL: API });
const login = await api.post('/api/auth/login', {
  data: { email: 'owner@acme.test', password: 'SchemaLoom!demo1' },
});
if (!login.ok()) throw new Error(`login failed (is the dev DB seeded?): ${await login.text()}`);

const browser = await chromium.launch();
const context = await browser.newContext({
  storageState: await api.storageState(),
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
});
const page = await context.newPage();

// A click that lands before React hydrates does nothing; retry until the form opens.
const open = async (button: string, field: string) => {
  for (let i = 0; i < 30; i++) {
    await page.getByRole('button', { name: button, exact: true }).click();
    if (await page.getByLabel(field, { exact: true }).isVisible()) return;
    await page.waitForTimeout(1000);
  }
  throw new Error(`"${button}" never opened`);
};

await page.goto(`${WEB}/acme`);
const existing = page.getByRole('link', { name: PROJECT });
if ((await existing.count()) === 0) {
  await open('Import', 'Target version');
  await page.getByLabel('Name', { exact: true }).fill(PROJECT);
  await page.getByLabel('Target version').fill('16');
  await page.getByRole('textbox', { name: 'SQL' }).fill(SQL.trim());
  await page.getByRole('button', { name: 'Create and import' }).click();
  await page.waitForURL(/\/p\/[^/]+$/, { timeout: 60_000 });
  await settle(page, 5000); // first ELK layout
  await page.goto(`${WEB}/acme`);
}
await page.getByRole('link', { name: PROJECT }).first().click();
await page.waitForURL(/\/p\/[^/]+$/);
const projectUrl = page.url();
await page.locator('.react-flow__node').first().waitFor();
await page.getByRole('button', { name: 'Fit View' }).click();
await settle(page);
await shot(page, 'canvas');

// Inspector: select the orders table.
// (Entity is the default tab; clicking the active tab collapses the panel.)
await page
  .locator('.react-flow__node', { hasText: /^orders/ })
  .first()
  .click();
await settle(page);
await shot(page, 'inspector');

// AI: ask about the selected tables.
await page
  .locator('.react-flow__node', { hasText: /^customers/ })
  .first()
  .click({ modifiers: ['Shift'] });
await page.getByRole('tab', { name: 'AI' }).click();
await page.getByRole('button', { name: 'New conversation' }).click();
await page.getByLabel('Question').fill('Top 10 customers by revenue in the last 90 days');
await page.getByRole('button', { name: 'Send' }).click();
await page.getByRole('button', { name: 'Send' }).waitFor({ timeout: 90_000 }); // "Answering…" ends
await settle(page, 2000);
await shot(page, 'ai-query');

await page.goto(`${projectUrl}/history`);
await settle(page);
await shot(page, 'history');

await browser.close();
await api.dispose();
console.log(`screenshots written to ${OUT}`);
