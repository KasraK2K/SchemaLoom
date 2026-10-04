import { defineConfig, devices } from '@playwright/test';
import { FAKE_ANTHROPIC_URL } from './fixtures/api';

/**
 * Doc 01 §12.2. Playwright starts both apps itself, so `pnpm test:e2e` behaves the same
 * on a laptop and in CI.
 *
 * Both are PRODUCTION starts, not `dev`: `test:e2e` depends on the two `#build` tasks,
 * which is why running it against unbuilt apps is impossible rather than merely
 * discouraged. `reuseExistingServer: !CI` lets a developer keep `pnpm dev` running.
 *
 * `globalSetup` refuses to run unless `DATABASE_URL_E2E` names a `_e2e` database, and it
 * runs before either server starts.
 */
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI === undefined ? 0 : 1,
  workers: 1,
  reporter: process.env.CI === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
  globalSetup: './global-setup.ts',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Workflow 3's AI steps: the api's Anthropic calls land here (scripts/fake-anthropic.ts).
      command: 'node --experimental-strip-types scripts/fake-anthropic.ts',
      url: `${FAKE_ANTHROPIC_URL}/calls`,
      reuseExistingServer: process.env.CI === undefined,
    },
    {
      command: 'pnpm --filter @schemaloom/api start',
      url: `${API_URL}/healthz`,
      reuseExistingServer: process.env.CI === undefined,
      timeout: 120_000,
      env: {
        DATABASE_URL: process.env.DATABASE_URL_E2E ?? '',
        REDIS_KEY_PREFIX: 'sl-e2e:',
        NODE_ENV: 'production',
        // Phase 6: workflow 10 reads the e2e database, which is on localhost.
        INTROSPECT_ALLOW_PRIVATE_HOSTS: 'true',
        // Roadmap 16: workflow 1 signs up strangers; workflow 13 covers invite-only.
        SIGNUP_MODE: 'open',
        // The SDK reads ANTHROPIC_BASE_URL; process env wins over the root .env's real key.
        ANTHROPIC_API_KEY: 'e2e-fake',
        ANTHROPIC_BASE_URL: FAKE_ANTHROPIC_URL,
        // Mail goes to Mailpit (SMTP_URL), never the real Mailgun account in the root .env.
        // Blank counts as unset (`env.ts`); workflow 19 reads the sign-in link from Mailpit.
        MAILGUN_API_KEY: '',
        MAILGUN_DOMAIN: '',
      },
    },
    {
      // NEXT_PUBLIC_* is inlined into the browser bundle at BUILD time, so this env only
      // covers the server-rendered half. The browser half is whatever `next build` saw;
      // both default to http://localhost:3001, which is what CI builds with.
      command: 'pnpm --filter @schemaloom/web start',
      url: BASE_URL,
      reuseExistingServer: process.env.CI === undefined,
      timeout: 120_000,
      env: { NEXT_PUBLIC_API_URL: API_URL },
    },
  ],
});
