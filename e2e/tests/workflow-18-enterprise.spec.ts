import { expect, request, test, type Browser, type Page } from '@playwright/test';
import { API_URL, signIn, signedInPage, write, type Session } from '../fixtures/api';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * Roadmap 14 (`docs/phase14/DESIGN.md`): the audit log viewer, and single sign-on.
 */

interface AuditPage {
  rows: { action: string; project: { id: string } | null; metadata: Record<string, unknown> }[];
  nextCursor: string | null;
}

const auditOf = async (session: Session, params = ''): Promise<AuditPage> => {
  const response = await session.api.get(`/api/organizations/${SEED.orgSlug}/audit-log${params}`);
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as AuditPage;
};

test.describe('workflow 18 — audit log', () => {
  test('owners read everything, admins only what they can see, others nothing', async () => {
    const owner = await signIn(SEED_EMAILS.owner);
    // A project only the owner holds a grant on: the admin can't open it (R13).
    const created = await owner.api.post('/api/projects', {
      headers: write(owner),
      data: {
        organizationId: SEED.orgId,
        name: `w18 audit ${String(Date.now())}`,
        engineId: 'postgresql',
        engineVersion: '16',
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const projectId = ((await created.json()) as { id: string }).id;
    const changed = await owner.api.patch(`/api/projects/${projectId}/settings`, {
      headers: write(owner),
      data: { ai: { enabled: false } },
    });
    expect(changed.status(), await changed.text()).toBe(200);

    const mine = await auditOf(owner, `?projectId=${projectId}`);
    expect(mine.rows.map((r) => r.action)).toContain('project.settings_changed');
    // Signing in just now left a row saying how.
    const logins = await auditOf(owner, '?action=auth.');
    expect(logins.rows[0]).toMatchObject({
      action: 'auth.login',
      metadata: { method: 'password' },
    });

    const admin = await signIn(SEED_EMAILS.admin);
    expect((await auditOf(admin, `?projectId=${projectId}`)).rows).toEqual([]);
    const adminAll = await auditOf(admin);
    expect(adminAll.rows.some((r) => r.project?.id === projectId)).toBe(false);

    for (const email of [SEED_EMAILS.analyst, SEED_EMAILS.freelancer]) {
      const other = await signIn(email);
      const refused = await other.api.get(`/api/organizations/${SEED.orgSlug}/audit-log`);
      expect(refused.status(), email).toBe(403);
    }

    const csv = await owner.api.get(
      `/api/organizations/${SEED.orgSlug}/audit-log.csv?projectId=${projectId}`,
    );
    expect(csv.status()).toBe(200);
    expect(csv.headers()['content-type']).toContain('text/csv');
    const text = await csv.text();
    expect(text.split('\n')[0]).toBe(
      'time,action,actor_email,actor_name,project,resource_type,resource_id,ip,metadata',
    );
    expect(text).toContain('project.settings_changed');
  });

  test('pages with a cursor', async () => {
    const owner = await signIn(SEED_EMAILS.owner);
    const first = await auditOf(owner);
    test.skip(first.nextCursor === null, 'fewer than one page of audit rows');
    const second = await auditOf(owner, `?before=${encodeURIComponent(first.nextCursor ?? '')}`);
    const firstIds = new Set(first.rows.map((r) => JSON.stringify(r)));
    expect(second.rows.some((r) => firstIds.has(JSON.stringify(r)))).toBe(false);
  });

  test('the owner filters the log in Settings', async ({ browser }) => {
    const page = await signedInPage(browser, SEED_EMAILS.owner);
    await page.goto(`/${SEED.orgSlug}/settings/audit-log`);
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    await page.getByLabel('Action').selectOption({ label: 'Sign-ins' });
    await expect(page.getByRole('cell', { name: 'auth login' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download CSV' })).toHaveAttribute(
      'href',
      /audit-log\.csv\?action=auth\./,
    );
  });

  test('a member gets no audit page', async ({ browser }) => {
    const page = await signedInPage(browser, SEED_EMAILS.analyst);
    const response = await page.goto(`/${SEED.orgSlug}/settings/audit-log`);
    expect(response?.status()).toBe(404);
  });
});

// ---------------------------------------------------------------------------------- SSO

const KEYCLOAK = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
const REALM = 'schemaloom-e2e';
const IDP_PASSWORD = 'Idp!pass1';

/** Keycloak's admin REST API, as the bootstrap admin of `docker compose --profile sso`. */
async function keycloakAdmin() {
  const api = await request.newContext({ baseURL: KEYCLOAK });
  const token = await api.post('/realms/master/protocol/openid-connect/token', {
    form: { grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: 'admin' },
  });
  expect(token.status(), await token.text()).toBe(200);
  const bearer = ((await token.json()) as { access_token: string }).access_token;
  const headers = { authorization: `Bearer ${bearer}` };
  const admin = {
    post: async (path: string, data: unknown) => {
      const r = await api.post(`/admin/realms${path}`, { headers, data });
      expect([201, 204, 409], `${path}: ${await r.text()}`).toContain(r.status());
    },
    get: async <T>(path: string): Promise<T> =>
      (await (await api.get(`/admin/realms${path}`, { headers })).json()) as T,
  };
  await admin.post('', { realm: REALM, enabled: true });
  return admin;
}

type KeycloakAdmin = Awaited<ReturnType<typeof keycloakAdmin>>;

async function keycloakUp(): Promise<boolean> {
  const api = await request.newContext();
  return api
    .get(`${KEYCLOAK}/realms/master`)
    .then((r) => r.ok())
    .catch(() => false);
}

async function idpUser(admin: KeycloakAdmin, email: string): Promise<void> {
  await admin.post(`/${REALM}/users`, {
    username: email,
    email,
    emailVerified: true,
    enabled: true,
    firstName: 'Kim',
    lastName: 'Sso',
    credentials: [{ type: 'password', value: IDP_PASSWORD, temporary: false }],
  });
}

/** The browser's whole round trip: our sign-in page → Keycloak's → back, signed in. */
async function signInWithSso(browser: Browser, email: string): Promise<Page> {
  const idpPort = new URL(KEYCLOAK).port;
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Continue with SSO' }).click();
  await page.waitForURL((url) => url.port === idpPort);
  await page.locator('#username').fill(email);
  await page.locator('#password').fill(IDP_PASSWORD);
  await page.locator('#kc-login').click();
  await page.waitForURL((url) => url.port !== idpPort && url.pathname !== '/login');
  return page;
}

interface Connection {
  id: string;
  hasClientSecret: boolean;
  sp: { redirectUri?: string; entityId?: string; acsUrl?: string };
}

async function createConnection(owner: Session, data: unknown): Promise<Connection> {
  const created = await owner.api.post(`/api/organizations/${SEED.orgSlug}/sso-connections`, {
    headers: write(owner),
    data,
  });
  expect(created.status(), await created.text()).toBe(201);
  return (await created.json()) as Connection;
}

const removeConnection = (owner: Session, id: string) =>
  owner.api.delete(`/api/organizations/${SEED.orgSlug}/sso-connections/${id}`, {
    headers: write(owner),
  });

const meOf = async (page: Page): Promise<string> =>
  ((await (await page.request.get(`${API_URL}/api/auth/me`)).json()) as { email: string }).email;

test('the owner adds, sees and removes a connection in Settings', async ({ browser }) => {
  const stamp = String(Date.now());
  const page = await signedInPage(browser, SEED_EMAILS.owner);
  await page.goto(`/${SEED.orgSlug}/settings/sso`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: 'Single sign-on' })).toBeVisible();
  await page.getByRole('button', { name: 'Add a connection' }).click();
  const form = page.getByRole('form', { name: 'New connection' });
  await form.getByLabel('Name').fill(`Okta ${stamp}`);
  await form.getByLabel('Email domains').fill(`ui-${stamp}.test`);
  await form.getByLabel('Issuer URL').fill('https://idp.example.com');
  await form.getByLabel('Client ID').fill('schemaloom');
  await form.getByLabel('Client secret').fill('s3cret');
  await form.getByRole('button', { name: 'Add connection' }).click();

  const item = page.getByRole('listitem').filter({ hasText: `Okta ${stamp}` });
  await expect(item).toContainText(`ui-${stamp}.test`);
  await expect(item).toContainText('/api/auth/sso/oidc/callback');
  await item.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('status')).toContainText(`Removed Okta ${stamp}`);
});

test.describe('workflow 18 — single sign-on (Keycloak)', () => {
  test.beforeEach(async () => {
    test.skip(
      !(await keycloakUp()),
      'Keycloak is not running: docker compose --profile sso up -d keycloak',
    );
  });

  test('OIDC: first sign-in creates a member (JIT), and it is audited', async ({ browser }) => {
    test.setTimeout(120_000);
    const stamp = String(Date.now());
    const domain = `oidc-${stamp}.test`;
    const email = `kim@${domain}`;
    const clientId = `sl-oidc-${stamp}`;
    const admin = await keycloakAdmin();
    await admin.post(`/${REALM}/clients`, {
      clientId,
      protocol: 'openid-connect',
      publicClient: false,
      secret: 'e2e-oidc-secret',
      standardFlowEnabled: true,
      redirectUris: [`${API_URL}/api/auth/sso/oidc/callback`],
    });
    await idpUser(admin, email);

    const owner = await signIn(SEED_EMAILS.owner);
    const conn = await createConnection(owner, {
      protocol: 'oidc',
      name: `Keycloak ${stamp}`,
      domains: [domain],
      oidcIssuer: `${KEYCLOAK}/realms/${REALM}`,
      oidcClientId: clientId,
      oidcClientSecret: 'e2e-oidc-secret',
      jit: true,
    });
    expect(conn.hasClientSecret).toBe(true);
    expect(JSON.stringify(conn)).not.toContain('e2e-oidc-secret');

    try {
      const page = await signInWithSso(browser, email);
      expect(await meOf(page)).toBe(email);

      const joined = await auditOf(owner, '?action=org_member.added');
      expect(joined.rows.some((r) => r.metadata.ssoConnectionId === conn.id)).toBe(true);
      const logins = await auditOf(owner, '?action=auth.login');
      expect(logins.rows.some((r) => r.metadata.method === 'sso')).toBe(true);
    } finally {
      await removeConnection(owner, conn.id);
    }
  });

  test('SAML: a signed assertion signs a new member in', async ({ browser }) => {
    test.setTimeout(120_000);
    const stamp = String(Date.now());
    const domain = `saml-${stamp}.test`;
    const email = `sam@${domain}`;
    const admin = await keycloakAdmin();
    const keys = await admin.get<{
      keys: { algorithm: string; use: string; certificate?: string }[];
    }>(`/${REALM}/keys`);
    const cert = keys.keys.find((k) => k.algorithm === 'RS256' && k.use === 'SIG')?.certificate;
    expect(cert).toBeDefined();

    const owner = await signIn(SEED_EMAILS.owner);
    const conn = await createConnection(owner, {
      protocol: 'saml',
      name: `Keycloak SAML ${stamp}`,
      domains: [domain],
      samlEntryPoint: `${KEYCLOAK}/realms/${REALM}/protocol/saml`,
      samlIdpCert: cert,
      jit: true,
    });
    // The IdP side, from the values the settings page shows.
    await admin.post(`/${REALM}/clients`, {
      clientId: conn.sp.entityId,
      protocol: 'saml',
      redirectUris: [conn.sp.acsUrl],
      attributes: {
        'saml.client.signature': 'false',
        'saml.assertion.signature': 'true',
        'saml.server.signature': 'true',
        saml_force_name_id_format: 'true',
        saml_name_id_format: 'email',
        'saml.force.post.binding': 'true',
        saml_assertion_consumer_url_post: conn.sp.acsUrl,
      },
    });
    await idpUser(admin, email);

    try {
      const page = await signInWithSso(browser, email);
      expect(await meOf(page)).toBe(email);
    } finally {
      await removeConnection(owner, conn.id);
    }
  });

  test('only owners manage connections; an unknown domain has no SSO', async () => {
    const admin = await signIn(SEED_EMAILS.admin);
    const refused = await admin.api.get(`/api/organizations/${SEED.orgSlug}/sso-connections`);
    expect(refused.status()).toBe(403);
    const anonymous = await request.newContext({ baseURL: API_URL });
    const found = await anonymous.post('/api/auth/sso/discover', {
      data: { email: 'nobody@no-sso-here.test' },
    });
    expect(await found.json()).toEqual({ connections: [] });
  });
});
