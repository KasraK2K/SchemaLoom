import { expect, request, test, type Browser, type Page } from '@playwright/test';
import { API_URL, signIn, signedInPage, write, type Session } from '../fixtures/api';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * Roadmap 14 (`docs/phase14/DESIGN.md`): the audit log viewer, and single sign-on.
 * Roadmap 14b (`docs/phase14/DIRECTORY-SYNC.md`): SCIM provisioning (a scripted client,
 * since Keycloak has none) and groups from a sign-in claim (Keycloak).
 * Roadmap 14c (§3): an IdP-initiated SAML response is bounced into a normal sign-in.
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
    put: async (path: string) => {
      const r = await api.put(`/admin/realms${path}`, { headers });
      expect(r.status(), `${path}: ${await r.text()}`).toBe(204);
    },
    delete: async (path: string) => {
      const r = await api.delete(`/admin/realms${path}`, { headers });
      expect([204, 404], `${path}: ${await r.text()}`).toContain(r.status());
    },
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
  name: string;
  hasClientSecret: boolean;
  sp: { redirectUri?: string; entityId?: string; acsUrl?: string; appTileUrl: string };
}

interface OrgGroup {
  id: string;
  name: string;
  managedBy: 'scim' | 'claim' | null;
  members: { userId: string; email: string }[];
}

const groupsOf = async (owner: Session): Promise<OrgGroup[]> => {
  const response = await owner.api.get(`/api/organizations/${SEED.orgSlug}/groups`);
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as OrgGroup[];
};

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

const clientUuid = async (admin: KeycloakAdmin, clientId = ''): Promise<string> =>
  (
    await admin.get<{ id: string }[]>(`/${REALM}/clients?clientId=${encodeURIComponent(clientId)}`)
  )[0]?.id ?? '';

/** A SAML connection here and its client in Keycloak, from the values the settings page shows. */
async function samlConnection(stamp: string, email: string, attributes: object = {}) {
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
    domains: [email.split('@')[1]],
    samlEntryPoint: `${KEYCLOAK}/realms/${REALM}/protocol/saml`,
    samlIdpCert: cert,
    jit: true,
  });
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
      ...attributes,
    },
  });
  await idpUser(admin, email);
  return { admin, owner, conn };
}

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
    const email = `sam@saml-${stamp}.test`;
    const { admin, owner, conn } = await samlConnection(stamp, email);
    expect(conn.sp.appTileUrl).toBe(`${API_URL}/api/auth/sso/${conn.id}/start`);
    try {
      const page = await signInWithSso(browser, email);
      expect(await meOf(page)).toBe(email);
    } finally {
      await removeConnection(owner, conn.id);
      await admin.delete(`/${REALM}/clients/${await clientUuid(admin, conn.sp.entityId)}`);
    }
  });

  test('SAML: an unrequested response from the IdP dashboard bounces into a sign-in', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const stamp = String(Date.now());
    const email = `tile@tile-${stamp}.test`;
    const tile = `sl-tile-${stamp}`;
    const { admin, owner, conn } = await samlConnection(stamp, email, {
      saml_idp_initiated_sso_url_name: tile,
    });
    const idpPort = new URL(KEYCLOAK).port;
    try {
      // What clicking the tile does: Keycloak signs in and posts, unasked, to our ACS.
      const page = await (await browser.newContext()).newPage();
      const acsPosts: string[] = [];
      page.on('response', (r) => {
        if (r.url() === conn.sp.acsUrl) acsPosts.push(r.headers().location ?? '');
      });
      await page.goto(`${KEYCLOAK}/realms/${REALM}/protocol/saml/clients/${tile}`);
      await page.locator('#username').fill(email);
      await page.locator('#password').fill(IDP_PASSWORD);
      await page.locator('#kc-login').click();
      await page.waitForURL((url) => url.port !== idpPort && url.pathname !== '/login');
      expect(await meOf(page)).toBe(email);
      // First the unrequested post (bounced), then the answer to our own request.
      expect(acsPosts[0]).toBe(`${API_URL}/api/auth/sso/${conn.id}/start?bounce=1`);
      expect(acsPosts).toHaveLength(2);
    } finally {
      await removeConnection(owner, conn.id);
      await admin.delete(`/${REALM}/clients/${await clientUuid(admin, conn.sp.entityId)}`);
    }
  });

  test('a groups claim fills a mapped group at sign-in, and empties it when the claim drops it', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const stamp = String(Date.now());
    const domain = `claim-${stamp}.test`;
    const email = `gia@${domain}`;
    const clientId = `sl-claim-${stamp}`;
    const kcGroup = `data-team-${stamp}`;
    const admin = await keycloakAdmin();
    await admin.post(`/${REALM}/clients`, {
      clientId,
      protocol: 'openid-connect',
      publicClient: false,
      secret: 'e2e-claim-secret',
      standardFlowEnabled: true,
      redirectUris: [`${API_URL}/api/auth/sso/oidc/callback`],
      protocolMappers: [
        {
          name: 'groups',
          protocol: 'openid-connect',
          protocolMapper: 'oidc-group-membership-mapper',
          config: {
            'claim.name': 'groups',
            'full.path': 'false',
            'id.token.claim': 'true',
            'access.token.claim': 'false',
            'userinfo.token.claim': 'false',
          },
        },
      ],
    });
    await idpUser(admin, email);
    await admin.post(`/${REALM}/groups`, { name: kcGroup });
    const [kcGroupRow] = await admin.get<{ id: string }[]>(
      `/${REALM}/groups?search=${kcGroup}&exact=true`,
    );
    const [kcUser] = await admin.get<{ id: string }[]>(
      `/${REALM}/users?email=${encodeURIComponent(email)}&exact=true`,
    );
    expect(kcGroupRow).toBeDefined();
    expect(kcUser).toBeDefined();
    const kcMembership = `/${REALM}/users/${kcUser?.id ?? ''}/groups/${kcGroupRow?.id ?? ''}`;
    await admin.put(kcMembership);

    const owner = await signIn(SEED_EMAILS.owner);
    const createdGroup = await owner.api.post(`/api/organizations/${SEED.orgSlug}/groups`, {
      headers: write(owner),
      data: { name: `Claimed ${stamp}` },
    });
    expect(createdGroup.status(), await createdGroup.text()).toBe(201);
    const group = (await createdGroup.json()) as OrgGroup;
    const conn = await createConnection(owner, {
      protocol: 'oidc',
      name: `Keycloak groups ${stamp}`,
      domains: [domain],
      oidcIssuer: `${KEYCLOAK}/realms/${REALM}`,
      oidcClientId: clientId,
      oidcClientSecret: 'e2e-claim-secret',
      jit: true,
      groupsClaim: 'groups',
    });
    const mapped = await owner.api.post(
      `/api/organizations/${SEED.orgSlug}/sso-connections/${conn.id}/group-mappings`,
      { headers: write(owner), data: { claimValue: kcGroup, groupId: group.id } },
    );
    expect(mapped.status(), await mapped.text()).toBe(204);

    const groupNow = async () => (await groupsOf(owner)).find((g) => g.id === group.id);
    try {
      const page = await signInWithSso(browser, email);
      expect(await meOf(page)).toBe(email);
      expect(await groupNow()).toMatchObject({ managedBy: 'claim' });
      expect((await groupNow())?.members.map((m) => m.email)).toEqual([email]);

      // The IdP drops the group; the next sign-in takes them out of it.
      await admin.delete(kcMembership);
      await signInWithSso(browser, email);
      expect((await groupNow())?.members).toEqual([]);
    } finally {
      await removeConnection(owner, conn.id);
      // Removing the connection hands the group back to people.
      expect(await groupNow()).toMatchObject({ managedBy: null });
      await owner.api.delete(`/api/organizations/${SEED.orgSlug}/groups/${group.id}`, {
        headers: write(owner),
      });
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

// --------------------------------------------------------------------------------- SCIM

const SCIM_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';

/** What Okta and Entra do, scripted: a bearer token and `application/scim+json`. */
async function scimClient(secret: string) {
  const api = await request.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: { authorization: `Bearer ${secret}`, accept: 'application/scim+json' },
  });
  const send = (method: 'post' | 'patch' | 'put', path: string, body: unknown) =>
    api[method](`/api/scim/v2${path}`, {
      headers: { 'content-type': 'application/scim+json' },
      data: JSON.stringify(body),
    });
  return {
    get: (path: string) => api.get(`/api/scim/v2${path}`),
    post: (path: string, body: unknown) => send('post', path, body),
    patch: (path: string, body: unknown) => send('patch', path, body),
    delete: (path: string) => api.delete(`/api/scim/v2${path}`),
  };
}

test.describe('workflow 18 — SCIM provisioning (roadmap 14b)', () => {
  test('a scripted IdP provisions, groups and deprovisions; a revoked token is 401', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const stamp = String(Date.now());
    const email = `scim-${stamp}@scim-e2e.test`;
    const owner = await signIn(SEED_EMAILS.owner);
    const conn = await createConnection(owner, {
      protocol: 'oidc',
      name: `SCIM ${stamp}`,
      domains: ['scim-e2e.test'],
      oidcIssuer: 'https://idp.example.com',
      oidcClientId: 'schemaloom',
    });
    const minted = await owner.api.post(
      `/api/organizations/${SEED.orgSlug}/sso-connections/${conn.id}/scim-token`,
      { headers: write(owner) },
    );
    expect(minted.status(), await minted.text()).toBe(201);
    const token = (await minted.json()) as { secret: string; baseUrl: string };
    expect(token.secret).toMatch(/^slscim_/);
    expect(token.baseUrl).toBe(`${API_URL}/api/scim/v2`);
    const scim = await scimClient(token.secret);
    let userId = '';

    try {
      expect((await scim.get('/ServiceProviderConfig')).status()).toBe(200);
      const lookup = await scim.get(
        `/Users?filter=${encodeURIComponent(`userName eq "${email}"`)}`,
      );
      expect(lookup.headers()['content-type']).toContain('application/scim+json');
      expect(((await lookup.json()) as { totalResults: number }).totalResults).toBe(0);

      const created = await scim.post('/Users', {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: email,
        name: { givenName: 'Sky', familyName: 'Provisioned' },
        emails: [{ primary: true, value: email, type: 'work' }],
        active: true,
      });
      expect(created.status(), await created.text()).toBe(201);
      userId = ((await created.json()) as { id: string }).id;

      const pushed = await scim.post('/Groups', {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: `SCIM team ${stamp}`,
        members: [{ value: userId }],
      });
      expect(pushed.status(), await pushed.text()).toBe(201);
      const groupId = ((await pushed.json()) as { id: string }).id;

      // In SchemaLoom the group is the IdP's: badge, no rename, no member edits.
      const page = await signedInPage(browser, SEED_EMAILS.owner);
      await page.goto(`/${SEED.orgSlug}/settings/groups`);
      const card = page.getByTestId('org-group').filter({ hasText: `SCIM team ${stamp}` });
      await expect(card).toContainText('Managed by your identity provider');
      await expect(card).toContainText('Sky Provisioned');
      await expect(card.getByRole('button', { name: 'Rename' })).toHaveCount(0);
      const edit = await owner.api.patch(`/api/organizations/${SEED.orgSlug}/groups/${groupId}`, {
        headers: write(owner),
        data: { name: 'Hijacked' },
      });
      expect(edit.status()).toBe(409);

      // Okta's deactivation: the membership goes at once.
      const deactivated = await scim.patch(`/Users/${userId}`, {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', value: { active: false } }],
      });
      expect(deactivated.status(), await deactivated.text()).toBe(200);
      expect(await deactivated.json()).toMatchObject({ active: false });
      const members = (await (
        await owner.api.get(`/api/organizations/${SEED.orgSlug}/members`)
      ).json()) as { userId: string }[];
      expect(members.some((m) => m.userId === userId)).toBe(false);

      // An owner is never deprovisioned from the IdP.
      const refused = await scim.delete(`/Users/${owner.userId}`);
      expect(refused.status()).toBe(409);
      expect(await refused.json()).toMatchObject({ schemas: [SCIM_ERROR], status: '409' });

      // Deleting the group in the IdP keeps it here as a normal group.
      expect((await scim.delete(`/Groups/${groupId}`)).status()).toBe(204);
      expect((await groupsOf(owner)).find((g) => g.id === groupId)).toMatchObject({
        managedBy: null,
        members: [],
      });
      await owner.api.delete(`/api/organizations/${SEED.orgSlug}/groups/${groupId}`, {
        headers: write(owner),
      });

      const revoked = await owner.api.delete(
        `/api/organizations/${SEED.orgSlug}/sso-connections/${conn.id}/scim-token`,
        { headers: write(owner) },
      );
      expect(revoked.status()).toBe(204);
      const after = await scim.get('/Users');
      expect(after.status()).toBe(401);
      expect(await after.json()).toMatchObject({ schemas: [SCIM_ERROR], status: '401' });
    } finally {
      await removeConnection(owner, conn.id);
    }
  });

  test('a SCIM token reaches nothing but /api/scim, and cookies never reach SCIM', async () => {
    const owner = await signIn(SEED_EMAILS.owner);
    const conn = await createConnection(owner, {
      protocol: 'oidc',
      name: `SCIM fence ${String(Date.now())}`,
      domains: ['scim-fence.test'],
      oidcIssuer: 'https://idp.example.com',
      oidcClientId: 'schemaloom',
    });
    try {
      const minted = await owner.api.post(
        `/api/organizations/${SEED.orgSlug}/sso-connections/${conn.id}/scim-token`,
        { headers: write(owner) },
      );
      const { secret } = (await minted.json()) as { secret: string };
      const bearer = await request.newContext({
        baseURL: API_URL,
        extraHTTPHeaders: { authorization: `Bearer ${secret}` },
      });
      expect((await bearer.get('/api/auth/me')).status()).toBe(401);
      expect((await owner.api.get('/api/scim/v2/Users')).status()).toBe(401);
    } finally {
      await removeConnection(owner, conn.id);
    }
  });
});
