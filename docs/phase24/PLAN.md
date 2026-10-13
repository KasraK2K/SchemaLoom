# AI Integrations Implementation Plan (roadmap 24)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI works without a key in `.env`: orgs and members add AI integrations in the dashboard, admins decide who may use which, and every AI ability resolves its integration and model through one resolver with lockable org and project defaults.

**Architecture:** Three new tables (`ai_integrations`, `ai_integration_grants`, `ai_ability_choices`) and an org-settings policy. A pure function `resolveChoice` applies the seven-step rule; `AiRouter` loads rows, calls it, and returns an `AiTarget`. `AiProvider.stream(target, …)` dispatches to the existing Anthropic code or to one OpenAI-SDK function (OpenAI, Gemini, OpenAI-compatible). `AiService` swaps `assertConfigured()` for `router.resolve()`; its prompts are untouched.

**Tech Stack:** NestJS 11, Prisma 6 (PostgreSQL 16), zod + nestjs-zod, vitest, `@anthropic-ai/sdk` (installed), `openai` (new), Next.js 15 + TanStack Query, Playwright.

**Spec:** `docs/phase24/DESIGN.md`. Read it before starting any task.

## Global Constraints

- pnpm only, never npm. Run api commands as `pnpm --filter @schemaloom/api …`, web as `pnpm --filter @schemaloom/web …`.
- Orient with `graphify query "<question>"` / `graphify explain` before grepping source. After code changes run `graphify update .`.
- Every route carries exactly one marker; each new controller has a `*.routes.spec.ts`. Org routes addressed by slug use `@Authenticated()` and check owner/admin in the service with `orgMembership` (`apps/api/src/organizations/members.service.ts`), answering **404** to anyone else.
- Invisible is 404, not 403. Another user's personal integration or choice is 404.
- Keys are encrypted with `encryptSecret(Buffer, SECRETS_ENCRYPTION_KEY)` from `apps/api/src/auth/totp.ts`, never returned, never written to `audit_logs.metadata`, never logged.
- `AiService`'s check order stays: 404 → `ai:use` 403 → `ai_disabled` 403 → 429 → resolve (503/422).
- Provider ids: `anthropic`, `openai`, `gemini`, `openai_compatible`. Ability ids: `chat`, `schema_draft`, `doc_drafts`. No provider or ability id hard-coded in `apps/web`.
- Error codes, verbatim: `ai_no_model` (503), `ai_locked_model_unavailable` (503), `ai_context_too_small` (422), `ai_server_integration_readonly` (409).
- New env (both optional): `AI_SERVER_MODELS` (comma list), `AI_ALLOW_PRIVATE_HOSTS` (default false).
- Commits: only when the user asks. If committing, the message ends with exactly `Co-Authored-By: Kasra Karami <kasra_k2k@yahoo.com>` and no other co-author line. The commit steps below are written for when commits are authorized; otherwise skip them and leave the work in the tree.
- Write in English.

## Deliberate narrowings of the spec (record in DESIGN.md "As built", Task 14)

- **No per-model context table.** §4.3's guard is implemented only as "map the provider's context-length error to 422 `ai_context_too_small`". Keeping a table of every model's context size is upkeep nobody asked for; add it when a pre-call check is requested.
- **No `reasoning_effort`.** The OpenAI path sends none and models run at their default. `capabilities.thinking` is `false` for non-Anthropic providers, so the UI says so.
- **Test connection = model list only**, no one-token fallback. A server without `/v1/models` shows `failing` with its error; the admin can still type model ids.
- **`DocDraft` gets no new column.** The job payload carries `{ integrationId, model }`; usage per integration is on `AiMessage` only.
- **User AI choices live on the Account page** (`/settings/security`) as a section, not a new `/settings/ai` route, like API tokens.
- **Project AI defaults** are a section in the existing project settings dialog (it has no tabs).
- **No `org.ai_policy_changed` action.** The policy is saved through the existing `PATCH /organizations/:orgSlug/settings`, which already writes its own settings audit row with the changed keys.

## File map

API (`apps/api`):

| File                                                             | Responsibility                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| `prisma/schema.prisma`                                           | three models, relations, `AiMessage.integrationId`                    |
| `prisma/migrations/20261011100000_ai_integrations/migration.sql` | tables, CHECKs, indexes, server-row backfill                          |
| `src/config/env.ts`                                              | `AI_SERVER_MODELS`, `AI_ALLOW_PRIVATE_HOSTS`                          |
| `src/ai-integrations/abilities.ts`                               | ability registry, provider list, capabilities                         |
| `src/ai-integrations/resolve.ts`                                 | pure resolution rule                                                  |
| `src/ai-integrations/guarded-fetch.ts`                           | `fetch` that pins a checked address (SSRF guard for custom base URLs) |
| `src/ai-integrations/ai-router.service.ts`                       | loads rows, resolves, decrypts → `AiTarget`; `/ai/options` view       |
| `src/ai-integrations/ai-integrations.service.ts`                 | CRUD, test, grants, choices, audit                                    |
| `src/ai-integrations/ai-integrations.dto.ts`                     | zod bodies                                                            |
| `src/ai-integrations/ai-integrations.controller.ts`              | org, `/me`, project, options routes                                   |
| `src/ai-integrations/ai-integrations.module.ts`, `index.ts`      | wiring                                                                |
| `src/ai/openai-chat.ts`                                          | OpenAI-SDK streaming adapter                                          |
| `src/ai/ai.provider.ts`                                          | `stream(target, …)` dispatch, `listModels(target)`                    |
| `src/ai/ai.service.ts`                                           | uses `AiRouter`                                                       |
| `src/organizations/organizations.service.ts`                     | new org gets its server row + `*` grant                               |
| `packages/contracts/src/org-settings.ts`                         | `ai` policy in org settings                                           |

Web (`apps/web/src`):

| File                                                                          | Responsibility                                 |
| ----------------------------------------------------------------------------- | ---------------------------------------------- |
| `features/ai-integrations/ai-integrations-api.ts`                             | zod schemas + fetchers                         |
| `features/ai-integrations/integration-list.tsx`                               | list + add/edit/test dialog (org and personal) |
| `features/ai-integrations/grants-editor.tsx`                                  | grants of one org integration                  |
| `features/ai-integrations/ability-choices.tsx`                                | per-ability rows (org, project, personal)      |
| `features/ai-integrations/personal-policy.tsx`                                | org toggle + provider checklist                |
| `features/ai-integrations/model-picker.tsx`                                   | in-feature picker reading `/ai/options`        |
| `app/(app)/[orgSlug]/settings/ai/page.tsx`                                    | org AI page                                    |
| `features/org-settings/org-settings-nav.tsx`                                  | "AI" tab                                       |
| `app/(app)/settings/security/page.tsx`                                        | personal section                               |
| `features/project/project-settings-dialog.tsx`                                | project defaults section                       |
| `features/ai/ai-api.ts`, `ai-panel.tsx`, `features/canvas/describe-panel.tsx` | errors, picker                                 |

e2e: `e2e/scripts/fake-anthropic.ts` (OpenAI endpoints), `e2e/tests/workflow-24-ai-integrations.spec.ts`.

---

### Task 1: Data model, migration, env, org-settings policy

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20261011100000_ai_integrations/migration.sql`
- Modify: `apps/api/src/config/env.ts` (beside `ANTHROPIC_API_KEY`, ~line 97)
- Modify: `packages/contracts/src/org-settings.ts`
- Test: `packages/contracts/src/org-settings.spec.ts` (create if absent; else add cases)

**Interfaces:**

- Produces: Prisma delegates `aiIntegration`, `aiIntegrationGrant`, `aiAbilityChoice`; `AiMessage.integrationId`; env keys `AI_SERVER_MODELS: string[]`, `AI_ALLOW_PRIVATE_HOSTS: boolean`; `OrgSettings['ai']: { allowPersonalIntegrations: boolean; personalProviders: string[] }`.

- [ ] **Step 1: Write the failing contracts test**

```ts
// packages/contracts/src/org-settings.spec.ts
import { describe, expect, it } from 'vitest';
import { applyOrgSettingsPatch, readOrgSettings } from './org-settings.js';

describe('org settings ai policy (roadmap 24 D4)', () => {
  it('defaults to personal integrations off, any provider', () => {
    expect(readOrgSettings({}).ai).toEqual({
      allowPersonalIntegrations: false,
      personalProviders: [],
    });
  });
  it('reads a malformed value as the default', () => {
    expect(
      readOrgSettings({ ai: { allowPersonalIntegrations: 'yes' } }).ai.allowPersonalIntegrations,
    ).toBe(false);
  });
  it('patches the policy and refuses an unknown provider', () => {
    const next = applyOrgSettingsPatch(
      {},
      { ai: { allowPersonalIntegrations: true, personalProviders: ['anthropic'] } },
    );
    expect(next.ai).toEqual({ allowPersonalIntegrations: true, personalProviders: ['anthropic'] });
    expect(() =>
      applyOrgSettingsPatch({}, {
        ai: { allowPersonalIntegrations: true, personalProviders: ['bedrock'] },
      } as never),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `pnpm --filter @schemaloom/contracts exec vitest run src/org-settings.spec.ts` → fails on `.ai` undefined.

- [ ] **Step 3: Add the policy to `org-settings.ts`**

```ts
/** Roadmap 24 D1. Kept here (not in the api) so the web reads the same list. */
export const AI_PROVIDER_IDS = ['anthropic', 'openai', 'gemini', 'openai_compatible'] as const;

/** Roadmap 24 D4: personal AI integrations are off until an owner or admin allows them. */
const aiPolicyInput = z
  .object({
    allowPersonalIntegrations: z.boolean().default(false),
    /** empty = any provider */
    personalProviders: z.array(z.enum(AI_PROVIDER_IDS)).max(4).default([]),
  })
  .strict();
const AI_POLICY_DEFAULT = { allowPersonalIntegrations: false, personalProviders: [] };
```

Add `ai: aiPolicyInput.default(AI_POLICY_DEFAULT)` to `orgSettingsInputSchema`, `ai: aiPolicyInput.catch(AI_POLICY_DEFAULT).default(AI_POLICY_DEFAULT)` to `orgSettingsStoredSchema`, and `ai: aiPolicyInput` to the `.object({...})` inside `orgSettingsPatchSchema`. Export `AI_PROVIDER_IDS` from `packages/contracts/src/index.ts` if `org-settings.ts` exports are listed there explicitly.

- [ ] **Step 4: Run it, expect PASS**, then `pnpm --filter @schemaloom/contracts build`.

- [ ] **Step 5: Env.** In `apps/api/src/config/env.ts` next to `ANTHROPIC_API_KEY`, add (follow the file's existing `z.preprocess` / boolean-flag helpers; `AUDIT_STREAM_ALLOW_PRIVATE_HOSTS` is the model for the flag):

```ts
    /** Roadmap 24 §6: more models offered from the server key; AI_MODEL is always first. */
    AI_SERVER_MODELS: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() !== '' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []),
      z.array(z.string().min(1).max(200)).max(20),
    ),
    /** Roadmap 24: an OpenAI-compatible base URL on a private address (a LAN Ollama). */
    AI_ALLOW_PRIVATE_HOSTS: <same helper as AUDIT_STREAM_ALLOW_PRIVATE_HOSTS>,
```

- [ ] **Step 6: Prisma models.** Append to `schema.prisma` (near `AiThread`):

```prisma
/// Roadmap 24 §2.1. Org integration (organizationId) or personal (ownerUserId), exactly one
/// (CHECK). `source = server` is the env key: one per org, no key column, read-only.
model AiIntegration {
  id             String    @id @default(cuid())
  organizationId String?   @map("organization_id")
  ownerUserId    String?   @map("owner_user_id")
  /// server | custom (CHECK)
  source         String
  /// anthropic | openai | gemini | openai_compatible (CHECK)
  provider       String
  name           String
  /// openai_compatible only (CHECK)
  baseUrl        String?   @map("base_url")
  /// AES-256-GCM under SECRETS_ENCRYPTION_KEY (the TOTP helper), never returned.
  apiKeyEnc      String?   @map("api_key_enc")
  keyHint        String?   @map("key_hint")
  allowedModels  String[]  @default([]) @map("allowed_models")
  /// unchecked | ok | failing (CHECK)
  status         String    @default("unchecked")
  lastError      String?   @map("last_error")
  lastCheckedAt  DateTime? @map("last_checked_at") @db.Timestamptz(6)
  createdById    String?   @map("created_by_id")
  createdAt      DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt      DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  organization Organization?        @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  owner        User?                @relation("AiIntegrationOwner", fields: [ownerUserId], references: [id], onDelete: Cascade)
  createdBy    User?                @relation("AiIntegrationCreatedBy", fields: [createdById], references: [id], onDelete: SetNull)
  grants       AiIntegrationGrant[]
  choices      AiAbilityChoice[]
  messages     AiMessage[]

  @@index([organizationId])
  @@index([ownerUserId])
  @@map("ai_integrations")
}

/// Roadmap 24 §2.2. Both null = everyone in the org; uniqueness is NULLS NOT DISTINCT (SQL).
model AiIntegrationGrant {
  id            String   @id @default(cuid())
  integrationId String   @map("integration_id")
  projectId     String?  @map("project_id")
  userId        String?  @map("user_id")
  createdById   String?  @map("created_by_id")
  createdAt     DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  integration AiIntegration @relation(fields: [integrationId], references: [id], onDelete: Cascade)
  project     Project?      @relation(fields: [projectId], references: [id], onDelete: Cascade)
  user        User?         @relation("AiGrantUser", fields: [userId], references: [id], onDelete: Cascade)
  createdBy   User?         @relation("AiGrantCreatedBy", fields: [createdById], references: [id], onDelete: SetNull)

  @@index([integrationId])
  @@map("ai_integration_grants")
}

/// Roadmap 24 §2.3. Scope = which of projectId/userId are set; `locked` only with userId null (CHECK).
model AiAbilityChoice {
  id             String   @id @default(cuid())
  ability        String
  organizationId String   @map("organization_id")
  projectId      String?  @map("project_id")
  userId         String?  @map("user_id")
  integrationId  String   @map("integration_id")
  model          String
  locked         Boolean  @default(false)
  updatedById    String?  @map("updated_by_id")
  updatedAt      DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  organization Organization  @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  project      Project?      @relation(fields: [projectId], references: [id], onDelete: Cascade)
  user         User?         @relation("AiChoiceUser", fields: [userId], references: [id], onDelete: Cascade)
  updatedBy    User?         @relation("AiChoiceUpdatedBy", fields: [updatedById], references: [id], onDelete: SetNull)
  integration  AiIntegration @relation(fields: [integrationId], references: [id], onDelete: Cascade)

  @@index([organizationId, ability])
  @@map("ai_ability_choices")
}
```

Add the back-relations: on `Organization` `aiIntegrations AiIntegration[]` and `aiChoices AiAbilityChoice[]`; on `Project` `aiGrants AiIntegrationGrant[]` and `aiChoices AiAbilityChoice[]`; on `User` `aiIntegrations AiIntegration[] @relation("AiIntegrationOwner")`, `aiIntegrationsCreated AiIntegration[] @relation("AiIntegrationCreatedBy")`, `aiGrants AiIntegrationGrant[] @relation("AiGrantUser")`, `aiGrantsCreated AiIntegrationGrant[] @relation("AiGrantCreatedBy")`, `aiChoices AiAbilityChoice[] @relation("AiChoiceUser")`, `aiChoicesUpdated AiAbilityChoice[] @relation("AiChoiceUpdatedBy")`. On `AiMessage` add

```prisma
  /// Roadmap 24 §2.4: which integration answered; kept when the integration is deleted.
  integrationId    String?       @map("integration_id")
  integration      AiIntegration? @relation(fields: [integrationId], references: [id], onDelete: SetNull)
```

- [ ] **Step 7: Migration SQL** (hand-written like the other migrations; Prisma cannot express the CHECKs, the partial index or NULLS NOT DISTINCT):

```sql
-- Roadmap 24 (docs/phase24/DESIGN.md §2)
CREATE TABLE "ai_integrations" (
  "id"              TEXT PRIMARY KEY,
  "organization_id" TEXT REFERENCES "organizations"("id") ON DELETE CASCADE,
  "owner_user_id"   TEXT REFERENCES "users"("id") ON DELETE CASCADE,
  "source"          TEXT NOT NULL,
  "provider"        TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "base_url"        TEXT,
  "api_key_enc"     TEXT,
  "key_hint"        TEXT,
  "allowed_models"  TEXT[] NOT NULL DEFAULT '{}',
  "status"          TEXT NOT NULL DEFAULT 'unchecked',
  "last_error"      TEXT,
  "last_checked_at" TIMESTAMPTZ(6),
  "created_by_id"   TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "ai_integrations_one_owner_ck" CHECK (("organization_id" IS NULL) <> ("owner_user_id" IS NULL)),
  CONSTRAINT "ai_integrations_source_ck" CHECK ("source" IN ('server', 'custom')),
  CONSTRAINT "ai_integrations_provider_ck" CHECK ("provider" IN ('anthropic', 'openai', 'gemini', 'openai_compatible')),
  CONSTRAINT "ai_integrations_server_ck" CHECK ("source" = 'custom' OR ("organization_id" IS NOT NULL AND "provider" = 'anthropic' AND "api_key_enc" IS NULL)),
  CONSTRAINT "ai_integrations_base_url_ck" CHECK ("base_url" IS NULL OR "provider" = 'openai_compatible'),
  CONSTRAINT "ai_integrations_key_ck" CHECK ("source" = 'server' OR "provider" = 'openai_compatible' OR "api_key_enc" IS NOT NULL),
  CONSTRAINT "ai_integrations_status_ck" CHECK ("status" IN ('unchecked', 'ok', 'failing'))
);
CREATE INDEX "ai_integrations_organization_id_idx" ON "ai_integrations"("organization_id");
CREATE INDEX "ai_integrations_owner_user_id_idx" ON "ai_integrations"("owner_user_id");
CREATE UNIQUE INDEX "ai_integrations_server_uq" ON "ai_integrations"("organization_id") WHERE "source" = 'server';

CREATE TABLE "ai_integration_grants" (
  "id"             TEXT PRIMARY KEY,
  "integration_id" TEXT NOT NULL REFERENCES "ai_integrations"("id") ON DELETE CASCADE,
  "project_id"     TEXT REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id"        TEXT REFERENCES "users"("id") ON DELETE CASCADE,
  "created_by_id"  TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX "ai_integration_grants_integration_id_idx" ON "ai_integration_grants"("integration_id");
CREATE UNIQUE INDEX "ai_integration_grants_scope_uq" ON "ai_integration_grants"("integration_id", "project_id", "user_id") NULLS NOT DISTINCT;

CREATE TABLE "ai_ability_choices" (
  "id"              TEXT PRIMARY KEY,
  "ability"         TEXT NOT NULL,
  "organization_id" TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "project_id"      TEXT REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id"         TEXT REFERENCES "users"("id") ON DELETE CASCADE,
  "integration_id"  TEXT NOT NULL REFERENCES "ai_integrations"("id") ON DELETE CASCADE,
  "model"           TEXT NOT NULL,
  "locked"          BOOLEAN NOT NULL DEFAULT false,
  "updated_by_id"   TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "ai_ability_choices_lock_ck" CHECK (NOT "locked" OR "user_id" IS NULL)
);
CREATE INDEX "ai_ability_choices_organization_id_ability_idx" ON "ai_ability_choices"("organization_id", "ability");
CREATE UNIQUE INDEX "ai_ability_choices_scope_uq" ON "ai_ability_choices"("organization_id", "ability", "project_id", "user_id") NULLS NOT DISTINCT;

ALTER TABLE "ai_messages" ADD COLUMN "integration_id" TEXT REFERENCES "ai_integrations"("id") ON DELETE SET NULL;

-- §6: every existing org gets its server row and a `*` grant, so a deploy with
-- ANTHROPIC_API_KEY behaves exactly as before.
INSERT INTO "ai_integrations" ("id", "organization_id", "source", "provider", "name", "updated_at")
SELECT 'aii_srv_' || "id", "id", 'server', 'anthropic', 'Server default', now() FROM "organizations";
INSERT INTO "ai_integration_grants" ("id", "integration_id")
SELECT 'aig_srv_' || "id", 'aii_srv_' || "id" FROM "organizations";
```

- [ ] **Step 8: Apply and generate**

Run: `pnpm --filter @schemaloom/api exec prisma migrate deploy && pnpm --filter @schemaloom/api exec prisma generate && pnpm --filter @schemaloom/api typecheck`
Expected: migration applied, typecheck passes. Then `pnpm --filter @schemaloom/api exec prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-schema-datasource prisma/schema.prisma --script` and confirm the only differences are the SQL-only objects (CHECKs, partial/NULLS NOT DISTINCT indexes), as for the existing slug index.

- [ ] **Step 9: Commit** (if authorized) — `git add apps/api/prisma packages/contracts apps/api/src/config/env.ts && git commit -m "AI integrations: tables, org policy, env (row 24)"`

---

### Task 2: Ability registry and the pure resolver

**Files:**

- Create: `apps/api/src/ai-integrations/abilities.ts`
- Create: `apps/api/src/ai-integrations/resolve.ts`
- Test: `apps/api/src/ai-integrations/resolve.spec.ts`

**Interfaces:**

- Produces:
  - `AI_ABILITIES`, `type AiAbility = 'chat' | 'schema_draft' | 'doc_drafts'`, `AI_ABILITY_IDS`, `isAiAbility(s): s is AiAbility`
  - `type AiProviderType` (= contracts `AI_PROVIDER_IDS[number]`), `PROVIDER_CAPABILITIES: Record<AiProviderType, { caching: boolean; thinking: boolean; fallback: boolean }>`
  - `IntegrationRow`, `GrantRow`, `ChoiceRow`, `ResolveInput`, `ResolutionStep`, `Resolution`
  - `usableModels(input, integration): string[]`, `isUsable(input, integration): boolean`, `resolveChoice(input): Resolution`

- [ ] **Step 1: `abilities.ts`**

```ts
import { AI_PROVIDER_IDS } from '@schemaloom/contracts';

/**
 * Roadmap 24 §3.3 — every server-side AI ability. A new AI feature adds one entry here and
 * calls `AiRouter.resolve(…, id)`; it never reads an AI key or model from env.
 */
export const AI_ABILITIES = [
  { id: 'chat', label: 'Assistant chat', strictOutput: false, background: false },
  { id: 'schema_draft', label: 'Describe it, get a schema', strictOutput: true, background: false },
  { id: 'doc_drafts', label: 'Draft docs', strictOutput: true, background: true },
] as const;
export type AiAbility = (typeof AI_ABILITIES)[number]['id'];
export const AI_ABILITY_IDS = AI_ABILITIES.map((a) => a.id) as [AiAbility, ...AiAbility[]];
export const isAiAbility = (s: string): s is AiAbility =>
  (AI_ABILITY_IDS as readonly string[]).includes(s);

export type AiProviderType = (typeof AI_PROVIDER_IDS)[number];

/** §4.2. `thinking` is false off Anthropic: the OpenAI path sends no reasoning_effort (PLAN). */
export const PROVIDER_CAPABILITIES: Record<
  AiProviderType,
  { readonly caching: boolean; readonly thinking: boolean; readonly fallback: boolean }
> = {
  anthropic: { caching: true, thinking: true, fallback: true },
  openai: { caching: true, thinking: false, fallback: false },
  gemini: { caching: true, thinking: false, fallback: false },
  openai_compatible: { caching: false, thinking: false, fallback: false },
};
```

- [ ] **Step 2: Write the failing resolver spec** (table-driven, covers §7 "Resolver")

```ts
import { describe, expect, it } from 'vitest';
import { resolveChoice, type ChoiceRow, type IntegrationRow, type ResolveInput } from './resolve';

const U = 'usr_u';
const P = 'prj_p';
const SERVER: IntegrationRow = {
  id: 'srv',
  ownerUserId: null,
  source: 'server',
  provider: 'anthropic',
  allowedModels: [],
};
const AZURE: IntegrationRow = {
  id: 'az',
  ownerUserId: null,
  source: 'custom',
  provider: 'openai_compatible',
  allowedModels: ['gpt-x', 'gpt-y'],
};
const MINE: IntegrationRow = {
  id: 'mine',
  ownerUserId: U,
  source: 'custom',
  provider: 'openai',
  allowedModels: ['gpt-m'],
};

const base = (over: Partial<ResolveInput> = {}): ResolveInput => ({
  userId: U,
  projectId: P,
  integrations: [SERVER, AZURE, MINE],
  grants: [
    { integrationId: 'srv', projectId: null, userId: null },
    { integrationId: 'az', projectId: null, userId: null },
  ],
  choices: [],
  policy: { allowPersonalIntegrations: true, personalProviders: [] },
  serverModels: ['claude-sonnet-5-5'],
  ...over,
});
const choice = (c: Partial<ChoiceRow>): ChoiceRow => ({
  projectId: null,
  userId: null,
  integrationId: 'az',
  model: 'gpt-x',
  locked: false,
  ...c,
});

describe('resolveChoice (roadmap 24 §3.2)', () => {
  it.each([
    [
      'project lock',
      [
        choice({ projectId: P, locked: true, model: 'gpt-y' }),
        choice({ projectId: P, userId: U, integrationId: 'mine', model: 'gpt-m' }),
      ],
      'project_lock',
      'gpt-y',
    ],
    [
      'org lock beats member choices',
      [choice({ locked: true }), choice({ userId: U, integrationId: 'mine', model: 'gpt-m' })],
      'org_lock',
      'gpt-x',
    ],
    [
      'member in project',
      [
        choice({ projectId: P, userId: U, integrationId: 'mine', model: 'gpt-m' }),
        choice({ userId: U, model: 'gpt-y' }),
      ],
      'user_project',
      'gpt-m',
    ],
    [
      'member everywhere',
      [choice({ userId: U, model: 'gpt-y' }), choice({ projectId: P })],
      'user',
      'gpt-y',
    ],
    ['project default', [choice({ projectId: P, model: 'gpt-y' }), choice({})], 'project', 'gpt-y'],
    ['org default', [choice({})], 'org', 'gpt-x'],
    ['server default', [], 'server', 'claude-sonnet-5-5'],
  ] as const)('%s wins', (_name, choices, step, model) => {
    expect(resolveChoice(base({ choices: [...choices] }))).toMatchObject({
      kind: 'ok',
      step,
      model,
    });
  });

  it('a project lock outranks an org lock', () => {
    const r = resolveChoice(
      base({
        choices: [choice({ locked: true }), choice({ projectId: P, locked: true, model: 'gpt-y' })],
      }),
    );
    expect(r).toMatchObject({ step: 'project_lock', model: 'gpt-y' });
  });

  it('an unusable lock is an error, never a fall-through', () => {
    const r = resolveChoice(
      base({
        grants: [{ integrationId: 'srv', projectId: null, userId: null }],
        choices: [choice({ locked: true })],
      }),
    );
    expect(r).toEqual({ kind: 'locked_unavailable', scope: 'org' });
  });

  it('skips a revoked grant and a removed model', () => {
    const revoked = resolveChoice(
      base({
        grants: [{ integrationId: 'srv', projectId: null, userId: null }],
        choices: [choice({})],
      }),
    );
    expect(revoked).toMatchObject({ step: 'server' });
    const removed = resolveChoice(base({ choices: [choice({ model: 'gone' })] }));
    expect(removed).toMatchObject({ step: 'server' });
  });

  it('matches grants by project, member, and member in project only', () => {
    const only = (g: { projectId: string | null; userId: string | null }) =>
      resolveChoice(
        base({ serverModels: [], grants: [{ integrationId: 'az', ...g }], choices: [choice({})] }),
      ).kind;
    expect(only({ projectId: P, userId: null })).toBe('ok');
    expect(only({ projectId: null, userId: U })).toBe('ok');
    expect(only({ projectId: P, userId: U })).toBe('ok');
    expect(only({ projectId: 'prj_other', userId: null })).toBe('none');
    expect(only({ projectId: null, userId: 'usr_other' })).toBe('none');
    expect(only({ projectId: P, userId: 'usr_other' })).toBe('none');
  });

  it('personal integrations follow the org policy', () => {
    const mineChoice = [choice({ userId: U, integrationId: 'mine', model: 'gpt-m' })];
    expect(
      resolveChoice(
        base({
          choices: mineChoice,
          policy: { allowPersonalIntegrations: false, personalProviders: [] },
        }),
      ),
    ).toMatchObject({ step: 'server' });
    expect(
      resolveChoice(
        base({
          choices: mineChoice,
          policy: { allowPersonalIntegrations: true, personalProviders: ['anthropic'] },
        }),
      ),
    ).toMatchObject({ step: 'server' });
    expect(
      resolveChoice(
        base({
          choices: mineChoice,
          policy: { allowPersonalIntegrations: true, personalProviders: ['openai'] },
        }),
      ),
    ).toMatchObject({ step: 'user' });
  });

  it('someone else’s personal integration is never usable', () => {
    const theirs: IntegrationRow = { ...MINE, id: 'theirs', ownerUserId: 'usr_other' };
    const r = resolveChoice(
      base({
        integrations: [SERVER, theirs],
        choices: [choice({ userId: U, integrationId: 'theirs', model: 'gpt-m' })],
      }),
    );
    expect(r).toMatchObject({ step: 'server' });
  });

  it('the server row needs an env key', () => {
    expect(resolveChoice(base({ serverModels: [] }))).toEqual({ kind: 'none' });
  });
});
```

- [ ] **Step 3: Run it, expect FAIL** — `pnpm --filter @schemaloom/api exec vitest run src/ai-integrations/resolve.spec.ts` → module not found.

- [ ] **Step 4: `resolve.ts`**

```ts
import type { AiProviderType } from './abilities';

/** Roadmap 24 §3.2, with no I/O: `AiRouter` loads the rows, this decides. */
export interface IntegrationRow {
  readonly id: string;
  /** set for a personal integration */
  readonly ownerUserId: string | null;
  readonly source: 'server' | 'custom';
  readonly provider: AiProviderType;
  readonly allowedModels: readonly string[];
}
export interface GrantRow {
  readonly integrationId: string;
  readonly projectId: string | null;
  readonly userId: string | null;
}
/** One ability's choices in this org, already narrowed to project ∈ {null, P}, user ∈ {null, U}. */
export interface ChoiceRow {
  readonly projectId: string | null;
  readonly userId: string | null;
  readonly integrationId: string;
  readonly model: string;
  readonly locked: boolean;
}
export interface ResolveInput {
  readonly userId: string;
  readonly projectId: string;
  /** the org's integrations plus the user's personal ones */
  readonly integrations: readonly IntegrationRow[];
  readonly grants: readonly GrantRow[];
  readonly choices: readonly ChoiceRow[];
  readonly policy: {
    readonly allowPersonalIntegrations: boolean;
    readonly personalProviders: readonly string[];
  };
  /** [] when ANTHROPIC_API_KEY is unset: the server row is then never usable */
  readonly serverModels: readonly string[];
}
export type ResolutionStep =
  'project_lock' | 'org_lock' | 'user_project' | 'user' | 'project' | 'org' | 'server';
export type Resolution =
  | {
      readonly kind: 'ok';
      readonly integrationId: string;
      readonly model: string;
      readonly step: ResolutionStep;
    }
  | { readonly kind: 'none' }
  | { readonly kind: 'locked_unavailable'; readonly scope: 'project' | 'org' };

export function usableModels(input: ResolveInput, integration: IntegrationRow): readonly string[] {
  return integration.source === 'server' ? input.serverModels : integration.allowedModels;
}

export function isUsable(input: ResolveInput, integration: IntegrationRow): boolean {
  if (usableModels(input, integration).length === 0) return false;
  if (integration.ownerUserId !== null) {
    const { allowPersonalIntegrations, personalProviders } = input.policy;
    return (
      integration.ownerUserId === input.userId &&
      allowPersonalIntegrations &&
      (personalProviders.length === 0 || personalProviders.includes(integration.provider))
    );
  }
  return input.grants.some(
    (g) =>
      g.integrationId === integration.id &&
      (g.projectId === null || g.projectId === input.projectId) &&
      (g.userId === null || g.userId === input.userId),
  );
}

export function resolveChoice(input: ResolveInput): Resolution {
  const byId = new Map(input.integrations.map((i) => [i.id, i]));
  const ok = (c: ChoiceRow | undefined): boolean => {
    const integration = c === undefined ? undefined : byId.get(c.integrationId);
    return (
      c !== undefined &&
      integration !== undefined &&
      isUsable(input, integration) &&
      usableModels(input, integration).includes(c.model)
    );
  };
  const at = (projectId: string | null, userId: string | null) =>
    input.choices.find((c) => c.projectId === projectId && c.userId === userId);
  const P = input.projectId;
  const U = input.userId;

  for (const [scope, row] of [
    ['project', at(P, null)],
    ['org', at(null, null)],
  ] as const) {
    if (row?.locked !== true) continue;
    if (!ok(row)) return { kind: 'locked_unavailable', scope };
    return {
      kind: 'ok',
      integrationId: row.integrationId,
      model: row.model,
      step: `${scope}_lock`,
    };
  }
  const steps: readonly [ResolutionStep, ChoiceRow | undefined][] = [
    ['user_project', at(P, U)],
    ['user', at(null, U)],
    ['project', at(P, null)],
    ['org', at(null, null)],
  ];
  for (const [step, row] of steps) {
    if (row !== undefined && ok(row))
      return { kind: 'ok', integrationId: row.integrationId, model: row.model, step };
  }
  const server = input.integrations.find((i) => i.source === 'server');
  const model = input.serverModels[0];
  if (server !== undefined && model !== undefined && isUsable(input, server)) {
    return { kind: 'ok', integrationId: server.id, model, step: 'server' };
  }
  return { kind: 'none' };
}
```

- [ ] **Step 5: Run it, expect PASS** (same command). Then `pnpm --filter @schemaloom/api lint`.

- [ ] **Step 6: Commit** (if authorized) — `git commit -m "AI integrations: ability registry and resolver (row 24)"`

---

### Task 3: Guarded fetch for custom base URLs

**Files:**

- Create: `apps/api/src/ai-integrations/guarded-fetch.ts`
- Test: `apps/api/src/ai-integrations/guarded-fetch.spec.ts`

**Interfaces:**

- Consumes: `resolveCheckedAddress(host, allowPrivate, resolve?)` from `src/introspect/address-guard.ts` (throws 422 `introspect.private_host` / `introspect.unreachable`).
- Produces: `guardedFetch(allowPrivate: boolean, resolve?: Resolve): typeof fetch` — every request resolves the host once, refuses private addresses unless allowed, and connects to exactly that address (no DNS rebinding between check and connect). Response body is a web `ReadableStream`, so SSE streaming works.

- [ ] **Step 1: Failing spec**

```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedFetch } from './guarded-fetch';

describe('guardedFetch (roadmap 24 §2.1 base_url)', () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      res.end(`data: ${req.method ?? ''} ${req.headers.host ?? ''}\n\n`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('refuses a private address without the opt-in', async () => {
    await expect(guardedFetch(false)(`http://127.0.0.1:${String(port)}/v1/models`)).rejects.toThrow(
      /private/i,
    );
  });

  it('streams from an allowed address and keeps the Host header', async () => {
    const res = await guardedFetch(true, () => Promise.resolve(['127.0.0.1']))(
      `http://llm.local:${String(port)}/v1/models`,
      { method: 'POST', body: '{}' },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`data: one\n\ndata: POST llm.local:${String(port)}\n\n`);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter @schemaloom/api exec vitest run src/ai-integrations/guarded-fetch.spec.ts`

- [ ] **Step 3: Implement** (same pinned-`lookup` trick as `audit-stream.core.ts` ~line 169)

```ts
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { resolveCheckedAddress, type Resolve } from '../introspect/address-guard';

/**
 * Roadmap 24 — the `fetch` handed to the OpenAI SDK for an `openai_compatible` base URL. The
 * host is resolved and checked once per request and the socket connects to that address, so a
 * DNS answer cannot change between the check and the connect. Public providers (OpenAI,
 * Gemini, Anthropic) use the SDK's own fetch.
 */
export function guardedFetch(allowPrivate: boolean, resolve?: Resolve): typeof fetch {
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const address = await resolveCheckedAddress(
      url.hostname.replace(/^\[|\]$/g, ''),
      allowPrivate,
      resolve,
    );
    const lookup = ((_host, options, callback) => {
      const family = address.includes(':') ? 6 : 4;
      if ((options as { all?: boolean }).all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    }) as LookupFunction;
    const headers = new Headers(init.headers);
    const body = init.body === undefined || init.body === null ? undefined : String(init.body);
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise<Response>((resolveResponse, reject) => {
      const req = transport.request(
        url,
        {
          method: init.method ?? 'GET',
          headers: Object.fromEntries(headers),
          lookup,
          signal: init.signal ?? undefined,
        },
        (res) => {
          const responseHeaders = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') responseHeaders.set(k, v);
            else if (Array.isArray(v)) for (const item of v) responseHeaders.append(k, item);
          }
          resolveResponse(
            new Response(Readable.toWeb(res) as ReadableStream, {
              status: res.statusCode ?? 0,
              headers: responseHeaders,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  };
}
```

The private-host error message names `INTROSPECT_ALLOW_PRIVATE_HOSTS`; the service maps `introspect.private_host` to `last_error = "the base URL is on a private network; a self-hosted install can allow it with AI_ALLOW_PRIVATE_HOSTS=true"` (Task 8).

- [ ] **Step 4: Run, expect PASS.** - [ ] **Step 5: Commit** (if authorized).

---

### Task 4: The OpenAI-SDK adapter

**Files:**

- Modify: `apps/api/package.json` (add `openai`)
- Create: `apps/api/src/ai/openai-chat.ts`
- Test: `apps/api/src/ai/openai-chat.spec.ts`

**Interfaces:**

- Consumes: `AiRequest`, `AiResult` from `./ai.provider`.
- Produces:
  - `GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/'`
  - `interface ChatClient { chat: { completions: { create(body: object, opts?: { signal?: AbortSignal }): Promise<AsyncIterable<ChatChunk>> } }; models: { list(): AsyncIterable<{ id: string }> } }` (the subset of `OpenAI` used; specs pass a stub)
  - `toChatBody(model: string, request: AiRequest): object`
  - `streamChat(client: ChatClient, model: string, request: AiRequest, onText, signal?): Promise<AiResult>`
  - `scrubKey(text: string, key: string | null): string`

- [ ] **Step 1: Add the dependency.** Run `npm view openai time --json` (read-only) and pick the newest version published more than 14 days ago; then `pnpm --filter @schemaloom/api add openai@<that version>`. Confirm the client accepts `{ apiKey, baseURL, fetch }` in its README/types.

- [ ] **Step 2: Failing spec**

```ts
import { describe, expect, it } from 'vitest';
import { scrubKey, streamChat, toChatBody, type ChatChunk, type ChatClient } from './openai-chat';

const REQUEST = {
  prefix: 'SYSTEM+SCHEMA',
  instructions: 'MODE',
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxTokens: 500,
};

function stub(chunks: ChatChunk[]): ChatClient & { bodies: object[] } {
  const bodies: object[] = [];
  return {
    bodies,
    chat: {
      completions: {
        create: (body: object) => {
          bodies.push(body);
          return Promise.resolve(
            (async function* () {
              yield* chunks;
            })(),
          );
        },
      },
    },
    models: {
      list: async function* () {
        yield { id: 'm' };
      },
    },
  };
}

describe('openai-chat (roadmap 24 §4.1)', () => {
  it('puts the cached prefix first and asks for usage', () => {
    expect(toChatBody('gpt-x', REQUEST)).toEqual({
      model: 'gpt-x',
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 500,
      messages: [
        { role: 'system', content: 'SYSTEM+SCHEMA' },
        { role: 'system', content: 'MODE' },
        { role: 'user', content: 'hi' },
      ],
    });
  });

  it('streams text and maps finish reasons and usage', async () => {
    const client = stub([
      { model: 'gpt-x-2026', choices: [{ delta: { content: 'Hel' }, finish_reason: null }] },
      {
        model: 'gpt-x-2026',
        choices: [{ delta: { content: 'lo' }, finish_reason: 'content_filter' }],
      },
      { model: 'gpt-x-2026', choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
    ]);
    const seen: string[] = [];
    const result = await streamChat(client, 'gpt-x', REQUEST, (t) => seen.push(t));
    expect(seen).toEqual(['Hel', 'lo']);
    expect(result).toEqual({
      text: 'Hello',
      stopReason: 'refusal',
      model: 'gpt-x-2026',
      tokensIn: 12,
      tokensOut: 3,
    });
  });

  it('maps length to max_tokens and missing usage to null', async () => {
    const result = await streamChat(
      stub([{ choices: [{ delta: {}, finish_reason: 'length' }] }]),
      'gpt-x',
      REQUEST,
      () => undefined,
    );
    expect(result).toMatchObject({
      stopReason: 'max_tokens',
      model: 'gpt-x',
      tokensIn: null,
      tokensOut: null,
    });
  });

  it('scrubs the key out of provider errors', () => {
    expect(scrubKey('bad key sk-abc123 rejected', 'sk-abc123')).toBe('bad key *** rejected');
    expect(scrubKey('no key here', null)).toBe('no key here');
  });
});
```

- [ ] **Step 3: Run, expect FAIL.**

- [ ] **Step 4: Implement**

```ts
import type { AiRequest, AiResult } from './ai.provider';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

/** The streamed chunk fields read here (a subset of the SDK's ChatCompletionChunk). */
export interface ChatChunk {
  readonly model?: string;
  readonly choices: readonly {
    readonly delta: { readonly content?: string | null };
    readonly finish_reason: string | null;
  }[];
  readonly usage?: { readonly prompt_tokens: number; readonly completion_tokens: number } | null;
}
/** The subset of the `openai` client used, so specs pass a stub. */
export interface ChatClient {
  readonly chat: {
    readonly completions: {
      create(body: object, opts?: { signal?: AbortSignal }): Promise<AsyncIterable<ChatChunk>>;
    };
  };
  readonly models: { list(): AsyncIterable<{ readonly id: string }> };
}

/**
 * Roadmap 24 §4.1 — OpenAI, Gemini and OpenAI-compatible servers. The prefix goes first and
 * unchanged so automatic prefix caching can apply. No reasoning_effort (PLAN "narrowings").
 */
export function toChatBody(model: string, request: AiRequest): object {
  return {
    model,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: request.maxTokens ?? 16_000,
    messages: [
      { role: 'system', content: request.prefix },
      { role: 'system', content: request.instructions },
      ...request.messages.map((m) => ({ role: m.role, content: m.content })),
    ],
  };
}

const STOP: Record<string, string> = {
  content_filter: 'refusal',
  length: 'max_tokens',
  stop: 'end_turn',
};

export async function streamChat(
  client: ChatClient,
  model: string,
  request: AiRequest,
  onText: (text: string) => void,
  signal?: AbortSignal,
): Promise<AiResult> {
  const stream = await client.chat.completions.create(toChatBody(model, request), { signal });
  let text = '';
  let finish: string | null = null;
  let answeredBy = model;
  let usage: ChatChunk['usage'] = null;
  for await (const chunk of stream) {
    if (chunk.model !== undefined) answeredBy = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    for (const choice of chunk.choices) {
      const delta = choice.delta.content ?? '';
      if (delta !== '') {
        text += delta;
        onText(delta);
      }
      if (choice.finish_reason !== null) finish = choice.finish_reason;
    }
  }
  return {
    text,
    stopReason: finish === null ? null : (STOP[finish] ?? finish),
    model: answeredBy,
    tokensIn: usage?.prompt_tokens ?? null,
    tokensOut: usage?.completion_tokens ?? null,
  };
}

export function scrubKey(text: string, key: string | null): string {
  return key === null || key === '' ? text : text.split(key).join('***');
}
```

- [ ] **Step 5: Run, expect PASS.** - [ ] **Step 6: Commit** (if authorized).

---

### Task 5: `AiProvider` takes a target

**Files:**

- Modify: `apps/api/src/ai/ai.provider.ts`
- Test: `apps/api/src/ai/ai.provider.spec.ts` (create)

**Interfaces:**

- Consumes: `streamChat`, `scrubKey`, `GEMINI_BASE_URL`, `ChatClient` (Task 4); `guardedFetch` (Task 3); `AiProviderType` (Task 2).
- Produces:

```ts
export interface AiTarget {
  readonly integrationId: string;
  readonly source: 'server' | 'custom';
  readonly provider: AiProviderType;
  readonly model: string;
  /** decrypted for this call only; env key for the server row; null for a keyless openai_compatible */
  readonly apiKey: string | null;
  readonly baseUrl: string | null;
}
class AiProvider {
  stream(
    target: AiTarget,
    request: AiRequest,
    onText: (t: string) => void,
    signal?: AbortSignal,
  ): Promise<AiResult>;
  listModels(target: Omit<AiTarget, 'model' | 'integrationId'>): Promise<string[]>;
}
```

`configured`, `assertConfigured()` and the `model` field are **removed** (Task 7 removes their callers). Context-length errors from either SDK become `UnprocessableEntityException({ code: 'ai_context_too_small' })`; other errors are rethrown with the key scrubbed from `message`.

- [ ] **Step 1: Failing spec** — exercise the dispatch with injected client factories:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../config/env';
import { AiProvider, type AiTarget } from './ai.provider';

const config = {
  get: (k: string) => (k === 'AI_ALLOW_PRIVATE_HOSTS' ? false : undefined),
} as unknown as ConfigService<AppEnv, true>;
const REQ = { prefix: 'p', instructions: 'i', messages: [{ role: 'user' as const, content: 'q' }] };
const target = (over: Partial<AiTarget>): AiTarget => ({
  integrationId: 'i1',
  source: 'custom',
  provider: 'openai',
  model: 'gpt-x',
  apiKey: 'sk-secret',
  baseUrl: null,
  ...over,
});

describe('AiProvider dispatch (roadmap 24 §4.1)', () => {
  it('sends openai, gemini and openai_compatible through the chat adapter with the right base URL', async () => {
    const made: { baseURL?: string; hasFetch: boolean }[] = [];
    const provider = new AiProvider(config, {
      openai: (opts) => {
        made.push({ baseURL: opts.baseURL, hasFetch: opts.fetch !== undefined });
        return {
          chat: {
            completions: {
              create: () =>
                Promise.resolve(
                  (async function* () {
                    yield {
                      model: 'gpt-x',
                      choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
                    };
                  })(),
                ),
            },
          },
          models: { list: async function* () {} },
        };
      },
    });
    await provider.stream(target({}), REQ, () => undefined);
    await provider.stream(target({ provider: 'gemini' }), REQ, () => undefined);
    await provider.stream(
      target({ provider: 'openai_compatible', baseUrl: 'https://llm.example/v1', apiKey: null }),
      REQ,
      () => undefined,
    );
    expect(made).toEqual([
      { baseURL: undefined, hasFetch: false },
      { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', hasFetch: false },
      { baseURL: 'https://llm.example/v1', hasFetch: true },
    ]);
  });

  it('maps a context-length error to 422 and scrubs the key from others', async () => {
    const failing = (error: Error) =>
      new AiProvider(config, {
        openai: () => ({
          chat: { completions: { create: () => Promise.reject(error) } },
          models: { list: async function* () {} },
        }),
      });
    await expect(
      failing(Object.assign(new Error('too long'), { code: 'context_length_exceeded' })).stream(
        target({}),
        REQ,
        () => undefined,
      ),
    ).rejects.toMatchObject({ response: { code: 'ai_context_too_small' } });
    await expect(
      failing(new Error('key sk-secret is invalid')).stream(target({}), REQ, () => undefined),
    ).rejects.toThrow('key *** is invalid');
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Rewrite `ai.provider.ts`.** Keep `AiRequest`, `AiResult` and the Anthropic request body exactly as today. Structure:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable, Optional, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type { AiProviderType } from '../ai-integrations/abilities';
import { guardedFetch } from '../ai-integrations/guarded-fetch';
import type { AppEnv } from '../config/env';
import { GEMINI_BASE_URL, scrubKey, streamChat, type ChatClient } from './openai-chat';

// (AiRequest, AiResult unchanged)

export interface AiTarget {
  /* as in Interfaces above */
}

/** Test seam: specs build fake clients; production binds nothing and builds real ones per call. */
export const AI_CLIENT_FACTORIES = Symbol('AI_CLIENT_FACTORIES');
export interface AiClientFactories {
  readonly openai?: (opts: {
    apiKey: string;
    baseURL?: string;
    fetch?: typeof fetch;
  }) => ChatClient;
  readonly anthropic?: (opts: { apiKey: string; baseURL?: string }) => Anthropic;
}

/**
 * DESIGN §4.1 + roadmap 24 §4 — the one place AI SDKs are named. A client is built per call
 * from the resolved target; decrypted keys live only for that call. The server row passes
 * no baseURL, so the SDK still reads ANTHROPIC_BASE_URL (the e2e fake); a custom Anthropic
 * integration pins the public API so a stray env var never redirects a member's key.
 */
@Injectable()
export class AiProvider {
  constructor(
    private readonly config: ConfigService<AppEnv, true>,
    @Optional() @Inject(AI_CLIENT_FACTORIES) private readonly factories: AiClientFactories = {},
  ) {}

  async stream(
    target: AiTarget,
    request: AiRequest,
    onText: (t: string) => void,
    signal?: AbortSignal,
  ): Promise<AiResult> {
    try {
      return target.provider === 'anthropic'
        ? await this.streamAnthropic(target, request, onText, signal)
        : await streamChat(this.chatClient(target), target.model, request, onText, signal);
    } catch (error) {
      throw this.mapError(error, target.apiKey);
    }
  }

  async listModels(target: Omit<AiTarget, 'model' | 'integrationId'>): Promise<string[]> {
    try {
      const ids: string[] = [];
      const list =
        target.provider === 'anthropic'
          ? this.anthropic(target).models.list()
          : this.chatClient(target).models.list();
      for await (const m of list) ids.push(m.id);
      return ids.sort();
    } catch (error) {
      throw this.mapError(error, target.apiKey);
    }
  }

  private anthropic(target: Pick<AiTarget, 'source' | 'apiKey'>): Anthropic {
    const opts = {
      apiKey: target.apiKey ?? '',
      ...(target.source === 'custom' ? { baseURL: 'https://api.anthropic.com' } : {}),
    };
    return this.factories.anthropic?.(opts) ?? new Anthropic(opts);
  }

  private chatClient(target: Pick<AiTarget, 'provider' | 'apiKey' | 'baseUrl'>): ChatClient {
    const opts = {
      // A keyless local server still needs a non-empty string for the SDK.
      apiKey: target.apiKey ?? 'none',
      ...(target.provider === 'gemini' ? { baseURL: GEMINI_BASE_URL } : {}),
      ...(target.provider === 'openai_compatible' && target.baseUrl !== null
        ? {
            baseURL: target.baseUrl,
            fetch: guardedFetch(this.config.get('AI_ALLOW_PRIVATE_HOSTS', { infer: true })),
          }
        : {}),
    };
    return this.factories.openai?.(opts) ?? (new OpenAI(opts) as unknown as ChatClient);
  }

  private async streamAnthropic(
    target: AiTarget,
    request: AiRequest,
    onText: (t: string) => void,
    signal?: AbortSignal,
  ): Promise<AiResult> {
    const stream = this.anthropic(target).beta.messages.stream(
      { model: target.model /* …the existing body, unchanged… */ },
      { signal },
    );
    // …the existing loop and finalMessage mapping, unchanged…
  }

  private mapError(error: unknown, key: string | null): unknown {
    const e = error as {
      code?: unknown;
      error?: { error?: { code?: unknown } };
      message?: unknown;
    };
    const text = typeof e.message === 'string' ? e.message : '';
    if (
      e.code === 'context_length_exceeded' ||
      e.error?.error?.code === 'context_length_exceeded' ||
      /prompt is too long|maximum context length/i.test(text)
    ) {
      return new UnprocessableEntityException({ code: 'ai_context_too_small' });
    }
    if (error instanceof Error && key !== null && text.includes(key))
      error.message = scrubKey(text, key);
    return error;
  }
}
```

Keep the existing class doc comment's paragraph about Sonnet 5.5, adaptive thinking and `fallbacks: "default"`, now scoped to the Anthropic branch.

- [ ] **Step 4: Run, expect PASS.** `pnpm --filter @schemaloom/api typecheck` will now fail in `ai.service.ts` (callers of `assertConfigured`/`configured`/the old `stream` signature); Task 7 fixes them. Do not commit until Task 7 if you commit per green build.

---

### Task 6: `AiRouter` — load, resolve, decrypt

**Files:**

- Create: `apps/api/src/ai-integrations/ai-router.service.ts`
- Test: `apps/api/src/ai-integrations/ai-router.int.spec.ts` (real Postgres via `DATABASE_URL_TEST`, like `audit-stream.int.spec.ts`)

**Interfaces:**

- Consumes: `resolveChoice`, `isUsable`, `usableModels` (Task 2), `AiTarget` (Task 5), `decryptSecret`, `readOrgSettings` from `@schemaloom/contracts`, `PROVIDER_CAPABILITIES`, `AI_ABILITIES`.
- Produces:

```ts
export interface AiOptionsView {
  readonly abilities: readonly {
    readonly id: AiAbility;
    readonly label: string;
    readonly strictOutput: boolean;
    readonly resolved: {
      readonly integrationId: string;
      readonly model: string;
      readonly step: ResolutionStep;
    } | null;
    readonly lock: { readonly scope: 'project' | 'org'; readonly usable: boolean } | null;
  }[];
  readonly integrations: readonly {
    readonly id: string;
    readonly name: string;
    readonly provider: AiProviderType;
    readonly source: 'server' | 'custom';
    readonly personal: boolean;
    readonly models: readonly string[];
    readonly capabilities: {
      readonly caching: boolean;
      readonly thinking: boolean;
      readonly fallback: boolean;
    };
  }[];
}
@Injectable()
class AiRouter {
  /** 503 ai_no_model / ai_locked_model_unavailable */
  resolve(
    userId: string,
    projectId: string,
    organizationId: string,
    ability: AiAbility,
  ): Promise<AiTarget>;
  /** the job re-check (§3.4): the same target if still usable, else null */
  usableTarget(
    userId: string,
    projectId: string,
    organizationId: string,
    integrationId: string,
    model: string,
  ): Promise<AiTarget | null>;
  options(userId: string, projectId: string, organizationId: string): Promise<AiOptionsView>;
  /** env models for the server row: [AI_MODEL, ...AI_SERVER_MODELS] deduped, or [] without ANTHROPIC_API_KEY */
  serverModels(): string[];
}
```

- [ ] **Step 1: Failing int spec** — seed one org, project, user directly with `PrismaClient`, construct `AiRouter` with a `ConfigService` stub (`ANTHROPIC_API_KEY`, `AI_MODEL`, `AI_SERVER_MODELS`, `SECRETS_ENCRYPTION_KEY = randomBytes(32).toString('base64')`) and the real client cast as `PrismaService`:

```ts
describe.skipIf(url === undefined)('AiRouter (roadmap 24 §3)', () => {
  // beforeAll: org `org_air`, user `usr_air`, project `prj_air` in it; server row 'aii_srv_org_air' + '*' grant
  // (as the migration does); custom openai integration 'aii_air' with apiKeyEnc = encryptSecret(Buffer.from('sk-air'), KEY), allowedModels ['gpt-x'].
  // afterAll: delete the org (cascades) and the user.

  it('falls back to the server default with the env model', async () => {
    expect(await router.resolve(U, P, O, 'chat')).toMatchObject({
      integrationId: 'aii_srv_org_air',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      apiKey: 'env-key',
      source: 'server',
    });
  });
  it('uses a granted org default and decrypts its key', async () => {
    await db.aiIntegrationGrant.create({ data: { integrationId: 'aii_air', projectId: P } });
    await db.aiAbilityChoice.create({
      data: { organizationId: O, ability: 'chat', integrationId: 'aii_air', model: 'gpt-x' },
    });
    expect(await router.resolve(U, P, O, 'chat')).toMatchObject({
      integrationId: 'aii_air',
      model: 'gpt-x',
      apiKey: 'sk-air',
    });
  });
  it('answers 503 ai_no_model without an env key and without grants', async () => {
    /* routerWithoutKey; grant deleted */
  });
  it('answers 503 ai_locked_model_unavailable for a broken lock', async () => {
    /* locked org choice on an ungranted integration */
  });
  it('the job re-check returns null after the grant is revoked', async () => {
    /* usableTarget → null */
  });
  it('options lists only usable integrations and never another user’s personal one', async () => {
    /* personal row for usr_other */
  });
});
```

Write each `it` body fully in the spec file (create rows, call, `expect`), using `rejects.toMatchObject({ status: 503, response: { code: 'ai_no_model' } })` for the throws.

- [ ] **Step 2: Run, expect FAIL** — `DATABASE_URL_TEST=<test db url> pnpm --filter @schemaloom/api test:int src/ai-integrations/ai-router.int.spec.ts`

- [ ] **Step 3: Implement**

```ts
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readOrgSettings } from '@schemaloom/contracts';
import { decryptSecret } from '../auth/totp';
import type { AppEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import type { AiTarget } from '../ai/ai.provider';
import {
  AI_ABILITIES,
  PROVIDER_CAPABILITIES,
  type AiAbility,
  type AiProviderType,
} from './abilities';
import {
  isUsable,
  resolveChoice,
  usableModels,
  type IntegrationRow,
  type ResolveInput,
} from './resolve';

const INTEGRATION_SELECT = {
  id: true,
  ownerUserId: true,
  source: true,
  provider: true,
  name: true,
  allowedModels: true,
  apiKeyEnc: true,
  baseUrl: true,
} as const;

/** Roadmap 24 §3 — every AI ability gets its integration and model here. */
@Injectable()
export class AiRouter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  serverModels(): string[] {
    if (!this.config.get('ANTHROPIC_API_KEY', { infer: true })) return [];
    return [
      ...new Set([
        this.config.get('AI_MODEL', { infer: true }),
        ...this.config.get('AI_SERVER_MODELS', { infer: true }),
      ]),
    ];
  }

  private async load(
    userId: string,
    projectId: string,
    organizationId: string,
    ability: AiAbility | null,
  ) {
    const [integrations, org, choices] = await Promise.all([
      this.prisma.aiIntegration.findMany({
        where: { OR: [{ organizationId }, { ownerUserId: userId }] },
        select: INTEGRATION_SELECT,
      }),
      this.prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { settings: true },
      }),
      ability === null
        ? Promise.resolve([])
        : this.prisma.aiAbilityChoice.findMany({
            where: {
              organizationId,
              ability,
              OR: [{ projectId: null }, { projectId }],
              AND: [{ OR: [{ userId: null }, { userId }] }],
            },
            select: {
              projectId: true,
              userId: true,
              integrationId: true,
              model: true,
              locked: true,
            },
          }),
    ]);
    const grants = await this.prisma.aiIntegrationGrant.findMany({
      where: {
        integrationId: { in: integrations.filter((i) => i.ownerUserId === null).map((i) => i.id) },
      },
      select: { integrationId: true, projectId: true, userId: true },
    });
    const input: ResolveInput = {
      userId,
      projectId,
      integrations: integrations as unknown as IntegrationRow[],
      grants,
      choices,
      policy: readOrgSettings(org.settings).ai,
      serverModels: this.serverModels(),
    };
    return { input, integrations };
  }

  private target(
    row: {
      id: string;
      source: string;
      provider: string;
      apiKeyEnc: string | null;
      baseUrl: string | null;
    },
    model: string,
  ): AiTarget {
    const key = this.config.get('SECRETS_ENCRYPTION_KEY', { infer: true });
    return {
      integrationId: row.id,
      source: row.source as AiTarget['source'],
      provider: row.provider as AiProviderType,
      model,
      apiKey:
        row.source === 'server'
          ? (this.config.get('ANTHROPIC_API_KEY', { infer: true }) ?? null)
          : row.apiKeyEnc === null
            ? null
            : decryptSecret(row.apiKeyEnc, key).toString(),
      baseUrl: row.baseUrl,
    };
  }

  async resolve(
    userId: string,
    projectId: string,
    organizationId: string,
    ability: AiAbility,
  ): Promise<AiTarget> {
    const { input, integrations } = await this.load(userId, projectId, organizationId, ability);
    const r = resolveChoice(input);
    if (r.kind === 'none') throw new ServiceUnavailableException({ code: 'ai_no_model' });
    if (r.kind === 'locked_unavailable')
      throw new ServiceUnavailableException({
        code: 'ai_locked_model_unavailable',
        scope: r.scope,
      });
    return this.target(
      integrations.find((i) => i.id === r.integrationId)!,
      r.model,
    );
  }

  async usableTarget(
    userId: string,
    projectId: string,
    organizationId: string,
    integrationId: string,
    model: string,
  ): Promise<AiTarget | null> {
    const { input, integrations } = await this.load(userId, projectId, organizationId, null);
    const row = integrations.find((i) => i.id === integrationId);
    const asRow = row as unknown as IntegrationRow | undefined;
    if (
      row === undefined ||
      !isUsable(input, asRow!) ||
      !usableModels(input, asRow!).includes(model)
    )
      return null;
    return this.target(row, model);
  }

  async options(userId: string, projectId: string, organizationId: string): Promise<AiOptionsView> {
    const abilities = await Promise.all(
      AI_ABILITIES.map(async (a) => {
        const { input } = await this.load(userId, projectId, organizationId, a.id);
        const r = resolveChoice(input);
        const lockRow = input.choices.find(
          (c) =>
            c.locked && c.userId === null && (c.projectId === projectId || c.projectId === null),
        );
        const lockScope = input.choices.some(
          (c) => c.locked && c.projectId === projectId && c.userId === null,
        )
          ? 'project'
          : lockRow
            ? 'org'
            : null;
        return {
          id: a.id,
          label: a.label,
          strictOutput: a.strictOutput,
          resolved:
            r.kind === 'ok'
              ? { integrationId: r.integrationId, model: r.model, step: r.step }
              : null,
          lock: lockScope === null ? null : { scope: lockScope, usable: r.kind === 'ok' },
        };
      }),
    );
    const { input, integrations } = await this.load(userId, projectId, organizationId, null);
    return {
      abilities,
      integrations: integrations
        .filter((i) => isUsable(input, i as unknown as IntegrationRow))
        .map((i) => ({
          id: i.id,
          name: i.name,
          provider: i.provider as AiProviderType,
          source: i.source as 'server' | 'custom',
          personal: i.ownerUserId !== null,
          models: [...usableModels(input, i as unknown as IntegrationRow)],
          capabilities: PROVIDER_CAPABILITIES[i.provider as AiProviderType],
        })),
    };
  }
}
```

ponytail: `options` loads once per ability (3 abilities × 4 queries). Fine at three abilities; fold into one load with all abilities' choices if the registry grows past ~10.

- [ ] **Step 4: Run, expect PASS.** - [ ] **Step 5: Commit** (if authorized).

---

### Task 7: `AiService` uses the router

**Files:**

- Modify: `apps/api/src/ai/ai.service.ts`
- Modify: `apps/api/src/ai/ai.module.ts` (import `AiIntegrationsModule`, Task 9, or provide `AiRouter` directly here first and move it in Task 9)
- Modify: `apps/api/src/ai/ai.service.spec.ts`
- Modify: `apps/web` nothing yet

**Interfaces:**

- Consumes: `AiRouter.resolve`, `AiRouter.usableTarget` (Task 6), `AiProvider.stream(target, …)` (Task 5).
- Produces: `DocDraftJobData` gains `integrationId: string; model: string`. `AiMessage.integrationId` is written on assistant rows. Read routes no longer throw 503.

- [ ] **Step 1: Update the spec first.** In `ai.service.spec.ts`:
  - Replace the `AiProvider` stub's `assertConfigured`/`configured` with nothing; its `stream` now takes `(target, request, onText)` — change the stub signature and every `mock.calls[n][0]` read of the request to `[n][1]`.
  - Add a router stub: `const router = { resolve: vi.fn().mockResolvedValue(TARGET), usableTarget: vi.fn().mockResolvedValue(TARGET) }` with `TARGET = { integrationId: 'aii_t', source: 'server', provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'k', baseUrl: null }`, and pass it to the `AiService` constructor.
  - Replace each "503 ai_not_configured" expectation: for posting a message, drafting a schema and enqueueing doc drafts, `router.resolve.mockRejectedValueOnce(new ServiceUnavailableException({ code: 'ai_no_model' }))` and expect `{ status: 503, response: { code: 'ai_no_model' } }`; for `listThreads`, `getThread`, `listDocDrafts`, `rejectDocDraft`, `acceptDocDraft`, assert they **resolve** with no router call (`expect(router.resolve).not.toHaveBeenCalled()`).
  - Add: `router.resolve` is called with `('usr_ana', PROJECT, 'org_1', 'chat')` from `prepareTurn`, `'schema_draft'` from `draftSchema`, `'doc_drafts'` from `enqueueDocDrafts`, and **after** the `ai:use`/`ai_disabled`/throttle checks (a 403 case asserts `router.resolve` not called).
  - Add: the stored assistant `aiMessage` row has `integrationId: 'aii_t'`.
  - Add: `runDocDraftJob` with `router.usableTarget` resolving `null` returns `{ drafted: 0 }` and calls no provider.
  - Add: the enqueued job data carries `{ integrationId: 'aii_t', model: 'claude-sonnet-5-5' }`.

- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter @schemaloom/api exec vitest run src/ai/ai.service.spec.ts`

- [ ] **Step 3: Change `ai.service.ts`**
  - Constructor: add `private readonly router: AiRouter`.
  - `PreparedTurn` gains `readonly target: AiTarget`.
  - `listThreads`, `getThread`, `createThread`, `listDocDrafts`, `rejectDocDraft`, `acceptDocDraft`: delete `this.provider.assertConfigured();`. (`createThread` writes a thread only; it calls no model.)
  - `prepareTurn`: replace `this.provider.assertConfigured(); await this.throttle(view);` with `await this.throttle(view); const target = await this.router.resolve(view.subject.userId, view.projectId, view.organizationId, 'chat');` and return `target`.
  - `runTurn`: `this.provider.stream(turn.target, { prefix, … }, stream.push, signal)`; in the assistant `aiMessage.create` data add `integrationId: turn.target.integrationId`.
  - `draftSchema`: same swap (`'schema_draft'`), then `this.provider.stream(target, {...}, () => undefined)`.
  - `enqueueDocDrafts`: swap (`'doc_drafts'`); job data `{ projectId, subject: view.subject, entityIds: ids, integrationId: target.integrationId, model: target.model }`.
  - `DocDraftJobData`: add `readonly integrationId: string; readonly model: string;`.
  - `runDocDraftJob`: replace `if (!this.provider.configured) return { drafted: 0 };` with, after `this.assertAiUse(view, ids);`:

```ts
// Roadmap 24 §3.4: the model picked at enqueue, if the requester may still use it.
const target = await this.router.usableTarget(
  view.subject.userId,
  view.projectId,
  view.organizationId,
  data.integrationId,
  data.model,
);
if (target === null) return { drafted: 0 };
```

    and pass `target` to `this.provider.stream`. A job enqueued before this deploy has no `integrationId`: treat `data.integrationId === undefined` as `return { drafted: 0 }` (the job is one-shot, and re-running it is one click).

- [ ] **Step 4: Run, expect PASS**, then `pnpm --filter @schemaloom/api typecheck && pnpm --filter @schemaloom/api test`. Fix any other `AiProvider` caller the typecheck lists (`graphify query "who calls AiProvider"`).

- [ ] **Step 5: Commit** (if authorized) — Tasks 5–7 together: `git commit -m "AI calls resolve their integration and model (row 24)"`

---

### Task 8: Management service and DTOs

**Files:**

- Create: `apps/api/src/ai-integrations/ai-integrations.dto.ts`
- Create: `apps/api/src/ai-integrations/ai-integrations.service.ts`
- Test: `apps/api/src/ai-integrations/ai-integrations.int.spec.ts`

**Interfaces:**

- Consumes: `orgMembership`, `encryptSecret`, `resolveCheckedAddress`, `AiProvider.listModels`, `AiRouter.serverModels`, `PermissionResolver` (`resolveProject`, `canOpenProject` from `../access`), `isAiAbility`.
- Produces (all throw 404 `{ code: 'not_found' }` for anything the caller may not manage):

```ts
export interface IntegrationView {
  id: string;
  name: string;
  provider: AiProviderType;
  source: 'server' | 'custom';
  personal: boolean;
  baseUrl: string | null;
  keyHint: string | null;
  models: string[];
  status: 'unchecked' | 'ok' | 'failing';
  lastError: string | null;
  lastCheckedAt: Date | null;
  capabilities: { caching: boolean; thinking: boolean; fallback: boolean };
}
export interface GrantView {
  id: string;
  projectId: string | null;
  projectName: string | null;
  userId: string | null;
  userName: string | null;
}
export interface ChoiceView {
  ability: AiAbility;
  projectId: string | null;
  userId: string | null;
  integrationId: string;
  model: string;
  locked: boolean;
}
type Owner = { kind: 'org'; userId: string; orgSlug: string } | { kind: 'me'; userId: string };
class AiIntegrationsService {
  list(owner: Owner): Promise<IntegrationView[]>;
  create(owner: Owner, input: CreateIntegrationInput): Promise<IntegrationView>;
  update(owner: Owner, id: string, input: UpdateIntegrationInput): Promise<IntegrationView>;
  remove(owner: Owner, id: string): Promise<void>;
  test(owner: Owner, id: string): Promise<IntegrationView & { fetchedModels: string[] }>;
  listGrants(userId: string, orgSlug: string, id: string): Promise<GrantView[]>;
  addGrant(userId: string, orgSlug: string, id: string, input: GrantInput): Promise<GrantView>;
  removeGrant(userId: string, orgSlug: string, id: string, grantId: string): Promise<void>;
  listChoices(scope: ChoiceScope): Promise<ChoiceView[]>;
  putChoice(scope: ChoiceScope, input: ChoiceInput): Promise<ChoiceView>;
  clearChoice(scope: ChoiceScope, ability: AiAbility): Promise<void>;
}
type ChoiceScope =
  | { kind: 'org'; userId: string; orgSlug: string }
  | { kind: 'project'; userId: string; projectId: string } // marker already checked sharing:manage
  | { kind: 'me'; userId: string; orgSlug: string; projectId: string | null };
```

- [ ] **Step 1: DTOs**

```ts
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AI_PROVIDER_IDS } from '@schemaloom/contracts';
import { AI_ABILITY_IDS } from './abilities';

const models = z.array(z.string().trim().min(1).max(200)).min(1).max(50);
const apiKey = z
  .string()
  .trim()
  .min(1)
  .max(4000)
  .regex(/^[^\r\n]*$/, 'one line');

export const createIntegrationSchema = z
  .object({
    provider: z.enum(AI_PROVIDER_IDS),
    name: z.string().trim().min(1).max(100),
    baseUrl: z
      .url({ protocol: /^https?$/ })
      .max(2000)
      .optional(),
    apiKey: apiKey.optional(),
    models,
  })
  .refine((b) => (b.provider === 'openai_compatible') === (b.baseUrl !== undefined), {
    message: 'baseUrl is required for openai_compatible and only there',
    path: ['baseUrl'],
  })
  .refine((b) => b.provider === 'openai_compatible' || b.apiKey !== undefined, {
    message: 'apiKey is required',
    path: ['apiKey'],
  });
export class CreateIntegrationDto extends createZodDto(createIntegrationSchema) {}
export type CreateIntegrationInput = z.infer<typeof createIntegrationSchema>;

/** Absent fields are kept; `apiKey` rotates. Provider can't change: delete and re-add. */
export const updateIntegrationSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    baseUrl: z.url({ protocol: /^https?$/ }).max(2000),
    apiKey,
    models,
  })
  .partial()
  .strict();
export class UpdateIntegrationDto extends createZodDto(updateIntegrationSchema) {}
export type UpdateIntegrationInput = z.infer<typeof updateIntegrationSchema>;

export const grantSchema = z
  .object({ projectId: z.string().min(1).nullable(), userId: z.string().min(1).nullable() })
  .strict();
export class GrantDto extends createZodDto(grantSchema) {}
export type GrantInput = z.infer<typeof grantSchema>;

export const choiceSchema = z
  .object({
    ability: z.enum(AI_ABILITY_IDS),
    integrationId: z.string().min(1),
    model: z.string().min(1).max(200),
    locked: z.boolean().default(false),
  })
  .strict();
export class ChoiceDto extends createZodDto(choiceSchema) {}
export type ChoiceInput = z.infer<typeof choiceSchema>;
```

`http://` is allowed only for `openai_compatible` (a LAN Ollama); the private-host check (below) still applies.

- [ ] **Step 2: Failing int spec.** Real DB like Task 6. Seed an org with owner `usr_o`, admin `usr_a`, member `usr_m`, project `prj_x`, and a second org `org_y` with project `prj_y`. Construct the service with the real Prisma client, a `ConfigService` stub, an `AiProvider` stub (`listModels: vi.fn().mockResolvedValue(['gpt-x', 'gpt-y'])`), the real `AiRouter`, and a `PermissionResolver` stub (`resolveProject` → map; `canOpenProject` → true for `prj_x` only). Cases — write each fully:
  1. owner and admin can create an org integration; member gets 404; the response has `keyHint: 'a1b2'` (key `sk-test-a1b2`) and no `apiKeyEnc`/`apiKey` property (`expect(JSON.stringify(view)).not.toContain('sk-test')`).
  2. the stored row's `apiKeyEnc` decrypts to the key; the audit row `ai_integration.created` exists and its `metadata` does not contain the key.
  3. `update({ apiKey })` writes `ai_integration.key_rotated`; `update` on the server row → 409 `ai_server_integration_readonly`; `remove` on it → 409.
  4. `test` stores `status: 'ok'` and returns `fetchedModels`; with `listModels` rejecting `new Error('bad sk-test-a1b2')`, stores `status: 'failing'` and `lastError: 'bad ***'`.
  5. `create` with `baseUrl: 'http://127.0.0.1:11434/v1'` and `AI_ALLOW_PRIVATE_HOSTS=false` → 422 `ai_private_base_url`; with it true → created.
  6. grants: `addGrant({ projectId: 'prj_y' })` (other org) → 404; duplicate grant → 409 `ai_grant_exists`; grants on a personal integration → 404.
  7. personal: member creates one under `{ kind: 'me' }`; another user's `update`/`remove`/`test` of it → 404; `list({ kind: 'org' })` never contains it.
  8. choices: org choice with a model not in the integration → 422 `ai_model_not_allowed`; org/project choice naming a personal integration → 422 `ai_integration_not_in_org`; `me` choice with `locked: true` → 422 `ai_lock_not_allowed`; `me` choice in `prj_y` (can't open) → 404; `me` choice with a personal integration of the caller → ok; the `ai_choice.set` audit row exists.
  9. the server row is listed only when `ANTHROPIC_API_KEY` is set.

- [ ] **Step 3: Run, expect FAIL.**

- [ ] **Step 4: Implement the service.** Rules (each is a test above):

```ts
@Injectable()
export class AiIntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly provider: AiProvider,
    private readonly router: AiRouter,
    private readonly resolver: PermissionResolver,
  ) {}

  /** owner or admin of the org, else the 404 of a missing org (as AuditStreamService.ownedOrg) */
  private async adminOrg(userId: string, orgSlug: string): Promise<string> {
    const member = await orgMembership(this.prisma, userId, orgSlug);
    if (member === null || (member.role !== 'owner' && member.role !== 'admin')) throw notFound();
    return member.organizationId;
  }
  private async memberOrg(userId: string, orgSlug: string): Promise<string> {
    const member = await orgMembership(this.prisma, userId, orgSlug);
    if (member === null) throw notFound();
    return member.organizationId;
  }
  /** where-clause for rows the owner may manage */
  private async scopeOf(owner: Owner) {
    return owner.kind === 'org' ? { organizationId: await this.adminOrg(owner.userId, owner.orgSlug) } : { ownerUserId: owner.userId };
  }
  private async row(owner: Owner, id: string) {
    const row = await this.prisma.aiIntegration.findFirst({ where: { id, ...(await this.scopeOf(owner)) } });
    if (row === null) throw notFound();
    if (row.source === 'server' && owner.kind === 'org' && !this.router.serverModels().length) throw notFound();
    return row;
  }
  private async checkBaseUrl(baseUrl: string | undefined): Promise<void> {
    if (baseUrl === undefined) return;
    try {
      await resolveCheckedAddress(new URL(baseUrl).hostname.replace(/^\[|\]$/g, ''), this.config.get('AI_ALLOW_PRIVATE_HOSTS', { infer: true }));
    } catch (error) {
      const code = (error as { getResponse?: () => { code?: string } }).getResponse?.().code;
      throw new UnprocessableEntityException({
        code: code === 'introspect.private_host' ? 'ai_private_base_url' : 'ai_base_url_unreachable',
        message: code === 'introspect.private_host'
          ? 'The base URL is on a private network. A self-hosted install can allow it with AI_ALLOW_PRIVATE_HOSTS=true.'
          : 'Could not find the base URL’s host.',
      });
    }
  }
  // view(row): IntegrationView — server row: models = router.serverModels(), keyHint null, baseUrl null.
  // audit(tx, { organizationId, actorUserId, action, resourceType: 'ai_integration' | 'ai_integration_grant' | 'ai_choice', resourceId, metadata }) —
  //   metadata only ever holds { provider, name, models, projectId, userId, ability, model, locked }, never a key.
  ...
}
```

Method bodies, in order:

- `list`: `findMany({ where: scope, orderBy: [{ source: 'desc' }, { createdAt: 'asc' }] })`, drop the server row when `serverModels()` is empty, map `view`.
- `create`: `checkBaseUrl`; in one transaction create `{ ...scope, source: 'custom', provider, name, baseUrl, apiKeyEnc: apiKey && encryptSecret(Buffer.from(apiKey), KEY), keyHint: apiKey?.slice(-4) ?? null, allowedModels: models, createdById: userId }` and audit `ai_integration.created` (`organizationId` = the org, or null for personal).
- `update`: `row()`; server row → `ConflictException({ code: 'ai_server_integration_readonly' })`; `baseUrl` only when `provider === 'openai_compatible'` (else 422 `ai_base_url_not_allowed`), `checkBaseUrl`; write; audit `ai_integration.key_rotated` when `apiKey` sent, else `ai_integration.updated`.
- `remove`: `row()`; server → 409 as above; delete (cascades); audit `ai_integration.deleted`.
- `test`: `row()`; `listModels({ source, provider, apiKey: decrypted (server: env), baseUrl })`; on success `status: 'ok', lastError: null`; on failure `status: 'failing', lastError: scrubKey(message, key).slice(0, 500)`; always `lastCheckedAt: new Date()`; audit `ai_integration.tested` with `{ ok }`; return view + `fetchedModels` (`[]` on failure).
- `listGrants`/`addGrant`/`removeGrant`: `adminOrg`; the integration must be `{ id, organizationId }` (a personal one never matches → 404); `addGrant` checks `projectId` belongs to the org (`project.findFirst({ id, organizationId, deletedAt: null })`, else 404) and `userId` is an org member (`orgMember.findFirst`, else 404); a P2002 unique violation → `ConflictException({ code: 'ai_grant_exists' })`; audit `ai_integration_grant.added`/`.removed`. `GrantView` joins project and user names.
- `listChoices`/`putChoice`/`clearChoice`: compute `{ organizationId, projectId, userId }` from the scope:
  - `org`: `adminOrg`, `(null, null)`.
  - `project`: `project.findFirstOrThrow({ id, deletedAt: null })` → its org, `(projectId, null)`. (The route marker already required `sharing:manage`.)
  - `me`: `memberOrg`; when `projectId` is set, `resolver.canOpenProject(await resolver.resolveProject({ kind: 'user', userId, orgId: organizationId }, projectId))` and the project's org equals `organizationId`, else 404; `(projectId, userId)`; `locked: true` → 422 `ai_lock_not_allowed`.
  - The integration must exist and be either an org integration of `organizationId` or (scope `me` only) the caller's own personal one, else 422 `ai_integration_not_in_org`. `model` must be in `allowedModels` (server row: `serverModels()`), else 422 `ai_model_not_allowed`.
  - Upsert by `(organizationId, ability, projectId, userId)`: `findFirst` then `update` or `create` inside a transaction (Prisma's `upsert` can't target a NULLS NOT DISTINCT index). Audit `ai_choice.set` / `ai_choice.cleared` with `{ ability, projectId, userId, model, locked }`, `projectId` also on the audit row's own `projectId` column.
  - `listChoices` returns the rows for exactly that scope (for `me` without `projectId`: the `(null, userId)` rows plus every `(projectId, userId)` row in the org, so the Account page lists the per-project overrides).

- [ ] **Step 5: Run, expect PASS.** - [ ] **Step 6: Commit** (if authorized).

---

### Task 9: Controllers, markers, module, new orgs

**Files:**

- Create: `apps/api/src/ai-integrations/ai-integrations.controller.ts`
- Create: `apps/api/src/ai-integrations/ai-integrations.routes.spec.ts`
- Create: `apps/api/src/ai-integrations/ai-integrations.module.ts`, `index.ts`
- Modify: `apps/api/src/app.module.ts` (import the module), `apps/api/src/ai/ai.module.ts` (import it; drop a local `AiRouter` provider if Task 7 added one)
- Modify: `apps/api/src/organizations/organizations.service.ts:76` (server row on create)
- Test: `apps/api/src/organizations/organizations.service.spec.ts` (or its int spec) — new org has its server row and `*` grant

**Interfaces:**

- Consumes: Task 8's service, `AiRouter.options`, `AI_ABILITIES`.
- Produces: the routes below. `AiIntegrationsModule` exports `AiRouter`.

- [ ] **Step 1: Routes spec first** (copy the `sweep()` helper verbatim from `src/ai/ai.routes.spec.ts`, swapping the controller classes):

```ts
it('serves exactly the roadmap 24 §5.1 routes', () => {
  expect(Object.keys(table).sort()).toEqual([
    'DELETE /api/me/ai/choices',
    'DELETE /api/me/ai/integrations/:id',
    'DELETE /api/organizations/:orgSlug/ai/choices',
    'DELETE /api/organizations/:orgSlug/ai/integrations/:id',
    'DELETE /api/organizations/:orgSlug/ai/integrations/:id/grants/:grantId',
    'DELETE /api/projects/:projectId/ai/choices',
    'GET /api/ai/abilities',
    'GET /api/me/ai/choices',
    'GET /api/me/ai/integrations',
    'GET /api/organizations/:orgSlug/ai/choices',
    'GET /api/organizations/:orgSlug/ai/integrations',
    'GET /api/organizations/:orgSlug/ai/integrations/:id/grants',
    'GET /api/projects/:projectId/ai/choices',
    'GET /api/projects/:projectId/ai/options',
    'PATCH /api/me/ai/integrations/:id',
    'PATCH /api/organizations/:orgSlug/ai/integrations/:id',
    'POST /api/me/ai/integrations',
    'POST /api/me/ai/integrations/:id/test',
    'POST /api/organizations/:orgSlug/ai/integrations',
    'POST /api/organizations/:orgSlug/ai/integrations/:id/grants',
    'POST /api/organizations/:orgSlug/ai/integrations/:id/test',
    'PUT /api/me/ai/choices',
    'PUT /api/organizations/:orgSlug/ai/choices',
    'PUT /api/projects/:projectId/ai/choices',
  ]);
});
it('passes the boot sweep with one marker each', () => {
  expect(() => {
    assertRouteTable(routes);
  }).not.toThrow();
});
it('marks project choices with sharing:manage and options with project access', () => {
  expect(table['PUT /api/projects/:projectId/ai/choices']).toEqual([PERM_META]);
  expect(table['GET /api/projects/:projectId/ai/options']).toEqual([PROJECT_ACCESS_META]);
  expect(table['GET /api/me/ai/integrations']).toEqual([AUTHENTICATED_META]);
});
```

(Use the marker-key constants the existing routes specs import from `../access`; check `ai.routes.spec.ts` for the exact assertion shape it uses for markers and mirror it.)

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Controllers.** Three small controllers in one file (each route one marker; `userIdOf(req)` as in `audit-stream.controller.ts`; `subjectOf`/`mapFor` as in `ai.controller.ts`):

```ts
@ApiTags('ai-integrations')
@Controller('organizations/:orgSlug/ai')
export class OrgAiIntegrationsController {
  constructor(private readonly svc: AiIntegrationsService) {}
  @Authenticated() @Get('integrations') list(@Req() req: Request, @Param('orgSlug') s: string) {
    return this.svc.list({ kind: 'org', userId: userIdOf(req), orgSlug: s });
  }
  @Authenticated() @Post('integrations') create(
    @Req() req: Request,
    @Param('orgSlug') s: string,
    @Body() b: CreateIntegrationDto,
  ) {
    return this.svc.create({ kind: 'org', userId: userIdOf(req), orgSlug: s }, b);
  }
  @Authenticated() @Patch('integrations/:id') update(/* … */) {}
  @Authenticated() @HttpCode(204) @Delete('integrations/:id') remove(/* … */) {}
  @Authenticated() @HttpCode(200) @Post('integrations/:id/test') test(/* … */) {}
  @Authenticated() @Get('integrations/:id/grants') grants(/* … */) {}
  @Authenticated() @Post('integrations/:id/grants') addGrant(/* … */) {}
  @Authenticated() @HttpCode(204) @Delete('integrations/:id/grants/:grantId') removeGrant(
    /* … */
  ) {}
  @Authenticated() @Get('choices') choices(/* … */) {}
  @Authenticated() @Put('choices') putChoice(/* … ChoiceDto */) {}
  @Authenticated() @HttpCode(204) @Delete('choices') clearChoice(
    @Query('ability') ability: string /* isAiAbility else 400 */,
  ) {}
}

@ApiTags('ai-integrations')
@Controller('me/ai')
export class MyAiIntegrationsController {
  /* integrations CRUD + test with { kind: 'me', userId };
  choices: GET ?orgSlug=&projectId=, PUT body ChoiceDto & { orgSlug, projectId? } (extend choiceSchema with orgSlug: z.string().min(1), projectId: z.string().min(1).nullable().default(null)),
  DELETE ?orgSlug=&ability=&projectId= */
}

@ApiTags('ai-integrations')
@Controller('projects/:projectId/ai')
export class ProjectAiController {
  constructor(
    private readonly svc: AiIntegrationsService,
    private readonly router: AiRouter,
    private readonly prisma: PrismaService,
  ) {}
  @RequirePermission('sharing:manage', { project: 'projectId' })
  @Get('choices') /* svc.listChoices({ kind: 'project', … }) */
  @RequirePermission('sharing:manage', { project: 'projectId' })
  @Put('choices')
  @RequirePermission('sharing:manage', { project: 'projectId' })
  @HttpCode(204)
  @Delete('choices')
  @RequireProjectAccess('projectId')
  @Get('options')
  async options(@Req() req: Request, @Param('projectId') projectId: string) {
    const project = await this.prisma.project.findFirstOrThrow({
      where: { id: projectId, deletedAt: null },
      select: { organizationId: true },
    });
    return this.router.options(userIdOf(req), projectId, project.organizationId);
  }
}
```

Write every elided handler in full: each is one line delegating to the service with the right `Owner`/`ChoiceScope`. Add `GET /ai/abilities` to `MyAiIntegrationsController` as `@Authenticated() @Get('/ai/abilities')` — Nest joins `me/ai` + path, so instead put it on a fourth tiny `@Controller('ai') class AiAbilitiesController { @Authenticated() @Get('abilities') list() { return { abilities: AI_ABILITIES }; } }` and include it in the sweep. A share-link subject on `options`: `userIdOf` throws 401 as in the other controllers; `RequireProjectAccess` alone would admit a link, so `options` checks `getSubject(req).kind === 'user'` and otherwise throws 404.

- [ ] **Step 4: Module**

```ts
@Module({
  controllers: [
    OrgAiIntegrationsController,
    MyAiIntegrationsController,
    ProjectAiController,
    AiAbilitiesController,
  ],
  providers: [AiIntegrationsService, AiRouter, AiProvider],
  exports: [AiRouter, AiProvider],
})
export class AiIntegrationsModule {}
```

`AiModule` imports `AiIntegrationsModule` and removes `AiProvider` from its own `providers` (one instance). Register `AiIntegrationsModule` in `app.module.ts`.

- [ ] **Step 5: New orgs get the server row.** In `organizations.service.ts` `create`:

```ts
          data: {
            name,
            slug,
            members: { create: { userId, role: 'owner' } },
            // Roadmap 24 §2.1: the env key as an integration, granted to everyone, as the migration does.
            aiIntegrations: { create: { source: 'server', provider: 'anthropic', name: 'Server default', grants: { create: {} } } },
          },
```

Add a test asserting a created org has exactly one `source: 'server'` integration with one grant `{ projectId: null, userId: null }` (int spec if the existing service spec uses a fake that can't do nested creates).

- [ ] **Step 6: Run** `pnpm --filter @schemaloom/api typecheck && pnpm --filter @schemaloom/api lint && pnpm --filter @schemaloom/api test`, and start the api once (`pnpm --filter @schemaloom/api start`) to confirm the boot sweep accepts the routes. Expected: all green, api boots.

- [ ] **Step 7: Commit** (if authorized) — `git commit -m "AI integrations: routes for orgs, members and projects (row 24)"`

---

### Task 10: Web — API client and the org AI page

**Files:**

- Create: `apps/web/src/features/ai-integrations/ai-integrations-api.ts`
- Create: `apps/web/src/features/ai-integrations/integration-list.tsx`
- Create: `apps/web/src/features/ai-integrations/grants-editor.tsx`
- Create: `apps/web/src/features/ai-integrations/ability-choices.tsx`
- Create: `apps/web/src/features/ai-integrations/personal-policy.tsx`
- Create: `apps/web/src/app/(app)/[orgSlug]/settings/ai/page.tsx`
- Modify: `apps/web/src/features/org-settings/org-settings-nav.tsx`
- Test: `apps/web/src/features/ai-integrations/ai-integrations-api.spec.ts`

**Interfaces:**

- Consumes: the routes of Task 9, `apiFetch` (`@/lib/api-client`), `Button` (`@schemaloom/ui`), `getOrgSettings`/`OrgSettingsSchema` (`features/org-settings/org-settings-api.ts`).
- Produces:
  - `IntegrationSchema`, `GrantSchema`, `ChoiceSchema`, `OptionsSchema`, `AbilitySchema` (zod, mirroring Task 8/6 views)
  - `type IntegrationBase = { kind: 'org'; orgSlug: string } | { kind: 'me' }` and `integrationsPath(base)`
  - `type ChoiceTarget = { kind: 'org'; orgSlug: string } | { kind: 'project'; projectId: string } | { kind: 'me'; orgSlug: string; projectId: string | null }` and `choicesPath(target)`, `choiceBody(target, input)`
  - `capabilityHints(c): string[]` → e.g. `['No fallback on refusal', 'No extended thinking']`
  - `stepLabel(step): string` (`server` → `Server default`, `org` → `Org default`, `project` → `Project default`, `user` → `Your choice`, `user_project` → `Your choice here`, `*_lock` → `Set by your admin`)
  - Components `IntegrationList({ base })`, `GrantsEditor({ orgSlug, integrationId, members, projects })`, `AbilityChoices({ target, integrations })`, `PersonalPolicy({ orgSlug })`

- [ ] **Step 1: Failing spec** for the pure helpers:

```ts
import { describe, expect, it } from 'vitest';
import { capabilityHints, choicesPath, integrationsPath, stepLabel } from './ai-integrations-api';

describe('ai-integrations-api', () => {
  it('builds the paths per owner', () => {
    expect(integrationsPath({ kind: 'org', orgSlug: 'acme co' })).toBe(
      '/organizations/acme%20co/ai/integrations',
    );
    expect(integrationsPath({ kind: 'me' })).toBe('/me/ai/integrations');
    expect(choicesPath({ kind: 'project', projectId: 'p1' })).toBe('/projects/p1/ai/choices');
    expect(choicesPath({ kind: 'me', orgSlug: 'acme', projectId: 'p1' })).toBe(
      '/me/ai/choices?orgSlug=acme&projectId=p1',
    );
  });
  it('words what a provider lacks', () => {
    expect(capabilityHints({ caching: true, thinking: true, fallback: true })).toEqual([]);
    expect(capabilityHints({ caching: false, thinking: false, fallback: false })).toEqual([
      'No prompt caching',
      'No extended thinking',
      'No fallback on refusal',
    ]);
  });
  it('labels where a choice came from', () => {
    expect(stepLabel('server')).toBe('Server default');
    expect(stepLabel('org_lock')).toBe('Set by your admin');
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter @schemaloom/web exec vitest run src/features/ai-integrations/ai-integrations-api.spec.ts`

- [ ] **Step 3: `ai-integrations-api.ts`** — zod schemas exactly mirroring `IntegrationView` (dates as `z.string().nullable()`), `GrantView`, `ChoiceView`, `AiOptionsView`; the helpers above; and fetchers `listIntegrations(base)`, `createIntegration(base, body)`, `updateIntegration(base, id, body)`, `deleteIntegration(base, id)`, `testIntegration(base, id)`, `listGrants/addGrant/removeGrant(orgSlug, id, …)`, `listChoices(target)`, `putChoice(target, body)`, `clearChoice(target, ability)`, `getOptions(projectId)`, `listAbilities()`. Each parses its response (`Schema.parse(await apiFetch<unknown>(path, { method, body }))`), as `audit-stream.tsx` does. Provider labels come from a local map keyed by the ids the API returns, with the raw id as fallback (no hard-coded list of which providers exist: the add dialog's provider `<select>` is built from `AI_PROVIDER_IDS` re-exported by `@schemaloom/contracts`, the same list the API validates against).

- [ ] **Step 4: Components.** Follow `audit-stream.tsx` for structure (TanStack `useQuery` + `useQueryClient().invalidateQueries`, a `run()` wrapper with `busy`/`message` state, `INPUT` class, `role="alert"` errors via `orgAdminMessage`):
  - `IntegrationList`: table rows `name · provider label · status dot (ok/failing/unchecked) · model count · badges` (server row: "Server · full features"; others: `capabilityHints` joined). Row actions: Test, Edit, Delete (Delete confirms inline with a second "Delete" button, since `confirm()` is unavailable in some viewers and the codebase avoids it). "Add integration" opens a form: provider `<select>`, name, base URL (shown only for `openai_compatible`), API key (`type="password"`, `autoComplete="off"`; on edit placeholder `•••• {keyHint}` and blank = keep), **Test & fetch models** (only after save — it calls `testIntegration` and fills a checkbox list from `fetchedModels`), and a "Add model id" text input + button for hand-typed ids. Save sends the ticked models.
  - `GrantsEditor`: list of grants ("Everyone", "Project: X", "Member: Y", "Y in X") with Remove; "Add access" with a `<select>` for scope (Everyone / Project / Member / Member in project) and the matching `<select>`s fed by `members` and `projects` props.
  - `AbilityChoices`: one row per ability from `listAbilities()`: integration `<select>` (from `integrations` prop, "— none —" clears), model `<select>` (that integration's models), lock checkbox (hidden for `kind: 'me'`), Save per row. For `kind: 'project'`, also fetch org-level locks via the project's `/ai/options` and show "Locked by the org" read-only rows.
  - `PersonalPolicy`: checkbox "Allow members to use their own AI keys in this organisation" and a checkbox per provider ("Any provider" when none ticked), saved through the existing `PATCH /organizations/:slug/settings` with `{ ai: {...} }`. Extend `OrgSettingsSchema` in `org-settings-api.ts` with `ai: z.object({ allowPersonalIntegrations: z.boolean(), personalProviders: z.array(z.string()) })`.

- [ ] **Step 5: Page + nav.** `page.tsx` mirrors `audit-log/page.tsx`: owner/admin only (`notFound()` otherwise), loads `listMembers` and `listProjects`, renders `<OrgSettingsNav current="ai" />`, `<h1>AI</h1>`, a one-line description ("Connect AI providers, decide who can use them, and pick the model for each AI feature."), then `IntegrationList base={{ kind: 'org', orgSlug }}` with a `GrantsEditor` expandable per org integration, `AbilityChoices target={{ kind: 'org', orgSlug }}`, `PersonalPolicy`. In `org-settings-nav.tsx` add `'ai'` to the `current` union and `{ key: 'ai', label: 'AI' }` to the owner/admin group after General.

- [ ] **Step 6: Run** `pnpm --filter @schemaloom/web exec vitest run src/features/ai-integrations && pnpm --filter @schemaloom/web typecheck && pnpm --filter @schemaloom/web lint`. Expected PASS.

- [ ] **Step 7: Browser check.** `pnpm infra:up`, start `pnpm dev` via the preview tool (`.claude/launch.json`), sign in as the seed owner, open `/acme/settings/ai`: the server row shows when the dev `.env` has a key; add an OpenAI-compatible integration pointing at `http://127.0.0.1:3009/v1` (needs `AI_ALLOW_PRIVATE_HOSTS=true` in the dev api env and the fake from Task 13 running) and see it listed; check the console has no errors; screenshot. Also check at 400 px width.

- [ ] **Step 8: Commit** (if authorized).

---

### Task 11: Web — personal integrations and project defaults

**Files:**

- Create: `apps/web/src/features/ai-integrations/personal-ai-section.tsx`
- Modify: `apps/web/src/app/(app)/settings/security/page.tsx`
- Modify: `apps/web/src/features/project/project-settings-dialog.tsx`

**Interfaces:**

- Consumes: Task 10 components and fetchers, `listOrganizations` (`@/features/projects`).

- [ ] **Step 1: `PersonalAiSection`** (client component): heading "AI integrations"; `IntegrationList base={{ kind: 'me' }}`; then, for each org from `listOrganizations()`, a sub-section "{org.name}" that reads `getOrgSettings` only when the user is owner/admin — members can't read org settings, so instead derive the policy from the org-scoped options: call `listChoices({ kind: 'me', orgSlug, projectId: null })` and show `AbilityChoices target={{ kind: 'me', orgSlug, projectId: null }}` with `integrations` = the user's personal integrations plus the org integrations the API reports usable. Add an endpoint-free note when no personal integration is usable in that org: "{org.name} doesn't allow personal AI keys; your choices here use the org's integrations." (The `/me/ai/choices` GET returns `{ choices, usableIntegrations, personalAllowed }`; add `usableIntegrations` and `personalAllowed` to Task 8's `listChoices` for the `me` scope — computed with `isUsable` over the org's grants for `(projectId ?? any, userId)`; update Task 8's spec case 8 accordingly.)

- [ ] **Step 2: Account page.** Add `<PersonalAiSection />` after `<NotificationPrefsSection />` in `settings/security/page.tsx`.

- [ ] **Step 3: Project dialog.** Under the existing AI toggles in `project-settings-dialog.tsx`, add a "Models" sub-heading and `<AbilityChoices target={{ kind: 'project', projectId }} integrations={…} />`, where `integrations` comes from `GET /organizations/:slug/ai/integrations` for admins, else from the project's `/ai/options` (the project manager may not be an org admin; options lists what _they_ can use, which is the honest set for them to pick from). Only render it when the AI switch is on.

- [ ] **Step 4: Run** web typecheck + lint + unit tests; browser-check both screens as in Task 10 Step 7 (owner, then the seed member).

- [ ] **Step 5: Commit** (if authorized).

---

### Task 12: Web — model picker in the features, new error messages

**Files:**

- Create: `apps/web/src/features/ai-integrations/model-picker.tsx`
- Modify: `apps/web/src/features/ai/ai-api.ts` (`aiErrorMessage`)
- Modify: `apps/web/src/features/ai/ai-api.spec.ts`
- Modify: `apps/web/src/features/ai/ai-panel.tsx`, `apps/web/src/features/canvas/describe-panel.tsx`, and the doc-draft trigger (find it with `graphify query "where are AI doc drafts requested in the web app"`)

**Interfaces:**

- Consumes: `getOptions`, `putChoice`, `stepLabel`, `capabilityHints`.
- Produces: `ModelPicker({ projectId, orgSlug, ability })` — renders `"{model} · {stepLabel}"`; a `<select>` of usable integration/model pairs; selecting one calls `putChoice({ kind: 'me', orgSlug, projectId }, { ability, integrationId, model })` then invalidates `['ai-options', projectId]`. Locked → disabled, text "Set by your admin". `strictOutput` ability on a provider whose `capabilities.fallback` is false → small hint "This model may not follow the strict output format; check the result." No model → nothing rendered (the error path covers it).

- [ ] **Step 1: Failing spec additions** in `ai-api.spec.ts`:

```ts
it('words the roadmap 24 errors', () => {
  expect(aiErrorMessage(new ApiError(503, 'ai_no_model', ''))).toBe(
    'No AI model is available here. An admin can add one in Settings → AI, or you can add your own key if your organisation allows it.',
  );
  expect(aiErrorMessage(new ApiError(503, 'ai_locked_model_unavailable', ''))).toBe(
    'Your admin set a model for this that is no longer available. Ask them to update it in Settings → AI.',
  );
  expect(aiErrorMessage(new ApiError(422, 'ai_context_too_small', ''))).toBe(
    'This model can’t take a selection this large. Select fewer tables, or pick a model with a bigger context.',
  );
});
```

Replace the existing `ai_not_configured` expectation with the `ai_no_model` one (the code no longer exists).

- [ ] **Step 2: Run, expect FAIL.** - [ ] **Step 3:** Update `aiErrorMessage` with those three branches (drop `ai_not_configured`). Build `model-picker.tsx`. Mount it: in the AI panel header (`ability="chat"`), in the describe panel next to its submit (`ability="schema_draft"`), beside the doc-draft action (`ability="doc_drafts"`). Where the panel currently shows the not-configured state, show the `ai_no_model` message with a link: org owner/admin → `/{orgSlug}/settings/ai`, others → `/settings/security`.

- [ ] **Step 4: Run** web unit tests, typecheck, lint; browser-check the AI panel shows "claude-sonnet-5-5 · Server default" with the dev key, and switching to an integration from Task 10 persists across reload.

- [ ] **Step 5: Commit** (if authorized).

---

### Task 13: e2e — fake OpenAI endpoints and workflow 24

**Files:**

- Modify: `e2e/scripts/fake-anthropic.ts`
- Modify: `e2e/playwright.config.ts` (api env `AI_ALLOW_PRIVATE_HOSTS: 'true'`)
- Create: `e2e/tests/workflow-24-ai-integrations.spec.ts`

- [ ] **Step 1: Fake OpenAI.** In `fake-anthropic.ts`, before the `/v1/messages` check, handle:

```ts
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
    const chunk = (delta: object, finish: string | null) =>
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
```

Update the file header to say it also stands in for an OpenAI-compatible server.

- [ ] **Step 2: Workflow 24** (API-driven like workflow 3, plus one browser assertion), skipped locally unless `E2E_FAKE_AI` like workflow 3:

```ts
import { expect, test } from '@playwright/test';
import { FAKE_ANTHROPIC_URL, signedInPage, signIn, write } from '../fixtures/api';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

test.describe('workflow 24: AI integrations', () => {
  test.skip(
    process.env.CI === undefined && process.env.E2E_FAKE_AI === undefined,
    'needs the fake AI (see workflow 3)',
  );

  test('an admin adds, grants and locks an integration; the lock wins over a personal key', async ({
    browser,
  }) => {
    const admin = await signIn(SEED_EMAILS.admin);
    const owner = await signIn(SEED_EMAILS.owner);
    const analyst = await signIn(SEED_EMAILS.analyst);
    const org = `/api/organizations/${SEED.orgSlug}`;
    const project = SEED.projectId;

    // The server row's `*` grant would serve everyone; take it away for this test, restore after.
    const list = (await (await admin.api.get(`${org}/ai/integrations`)).json()) as {
      id: string;
      source: string;
    }[];
    const server = list.find((i) => i.source === 'server')!;
    const grants = (await (
      await admin.api.get(`${org}/ai/integrations/${server.id}/grants`)
    ).json()) as { id: string; projectId: null; userId: null }[];
    const everyone = grants.find((g) => g.projectId === null && g.userId === null)!;
    await admin.api.delete(`${org}/ai/integrations/${server.id}/grants/${everyone.id}`, {
      headers: write(admin),
    });

    let integrationId = '';
    try {
      const created = await admin.api.post(`${org}/ai/integrations`, {
        headers: write(admin),
        data: {
          provider: 'openai_compatible',
          name: 'Fake LLM',
          baseUrl: `${FAKE_ANTHROPIC_URL}/v1`,
          models: ['fake-chat'],
        },
      });
      expect(created.status()).toBe(201);
      integrationId = ((await created.json()) as { id: string }).id;
      const tested = await admin.api.post(`${org}/ai/integrations/${integrationId}/test`, {
        headers: write(admin),
      });
      expect((await tested.json()) as { status: string; fetchedModels: string[] }).toMatchObject({
        status: 'ok',
        fetchedModels: ['fake-chat'],
      });

      await admin.api.post(`${org}/ai/integrations/${integrationId}/grants`, {
        headers: write(admin),
        data: { projectId: project, userId: analyst.userId },
      });
      await admin.api.put(`${org}/ai/choices`, {
        headers: write(admin),
        data: { ability: 'chat', integrationId, model: 'fake-chat', locked: true },
      });

      // The analyst's chat goes to the fake OpenAI endpoint.
      const thread = (await (
        await analyst.api.post(`/api/projects/${project}/ai/threads`, {
          headers: write(analyst),
          data: {
            title: 'w24',
            selection: {
              entityIds: [SEED.entities.orders],
              fieldIds: [],
              linkIds: [],
              areaIds: [],
            },
          },
        })
      ).json()) as { id: string };
      const before = (
        (await (await fetch(`${FAKE_ANTHROPIC_URL}/calls`)).json()) as { openai?: boolean }[]
      ).length;
      const sent = await analyst.api.post(`/api/ai/threads/${thread.id}/messages`, {
        headers: write(analyst),
        data: { content: 'orders over 100', mode: 'query' },
      });
      expect(sent.status()).toBe(200);
      const calls = (await (await fetch(`${FAKE_ANTHROPIC_URL}/calls`)).json()) as {
        openai?: boolean;
      }[];
      expect(calls.slice(before).some((c) => c.openai === true)).toBe(true);

      // The owner has no grant on it and the server row is ungranted: no model.
      const options = (await (
        await owner.api.get(`/api/projects/${project}/ai/options`)
      ).json()) as { abilities: { id: string; lock: { usable: boolean } | null }[] };
      expect(options.abilities.find((a) => a.id === 'chat')?.lock).toEqual({
        scope: 'org',
        usable: false,
      });
      const page = await signedInPage(browser, SEED_EMAILS.owner);
      await page.goto(`/${SEED.orgSlug}/p/${project}`);
      // open the AI panel and ask (use the same selectors workflow 3 uses), then:
      await expect(
        page.getByText('Your admin set a model for this that is no longer available.'),
      ).toBeVisible();

      // Personal keys allowed; the analyst adds one and picks it, the org lock still wins.
      await admin.api.patch(`${org}/settings`, {
        headers: write(admin),
        data: { ai: { allowPersonalIntegrations: true, personalProviders: [] } },
      });
      const mine = (await (
        await analyst.api.post('/api/me/ai/integrations', {
          headers: write(analyst),
          data: { provider: 'openai', name: 'Mine', apiKey: 'sk-e2e-mine', models: ['gpt-mine'] },
        })
      ).json()) as { id: string };
      await analyst.api.put('/api/me/ai/choices', {
        headers: write(analyst),
        data: {
          orgSlug: SEED.orgSlug,
          projectId: project,
          ability: 'chat',
          integrationId: mine.id,
          model: 'gpt-mine',
        },
      });
      const after = (await (
        await analyst.api.get(`/api/projects/${project}/ai/options`)
      ).json()) as {
        abilities: { id: string; resolved: { integrationId: string; step: string } | null }[];
      };
      expect(after.abilities.find((a) => a.id === 'chat')?.resolved).toMatchObject({
        integrationId,
        step: 'org_lock',
      });
      await analyst.api.delete(`/api/me/ai/integrations/${mine.id}`, { headers: write(analyst) });
    } finally {
      await admin.api.patch(`${org}/settings`, {
        headers: write(admin),
        data: { ai: { allowPersonalIntegrations: false, personalProviders: [] } },
      });
      await admin.api.delete(`${org}/ai/choices?ability=chat`, { headers: write(admin) });
      if (integrationId !== '')
        await admin.api.delete(`${org}/ai/integrations/${integrationId}`, {
          headers: write(admin),
        });
      await admin.api.post(`${org}/ai/integrations/${server.id}/grants`, {
        headers: write(admin),
        data: { projectId: null, userId: null },
      });
    }
  });
});
```

Fill in the AI-panel opening steps by copying them from `workflow-3-analyst-report.spec.ts`. The `SEED.entities.orders` id and the thread body shape are the ones workflow 3 uses; check them there.

- [ ] **Step 3: Run** — with the e2e DB per CLAUDE.md (export only `DATABASE_URL_E2E`), migrate it (`DATABASE_URL=$DATABASE_URL_E2E pnpm --filter @schemaloom/api exec prisma migrate deploy`), then `E2E_FAKE_AI=1 pnpm --filter e2e exec playwright test workflow-24 workflow-3 workflow-21`. Locally Playwright reuses running dev servers; stop `pnpm dev` first so the e2e api starts with the fake env (see memory "Browser verify with fake AI"). Expected: all pass.

- [ ] **Step 4: Commit** (if authorized).

---

### Task 14: Docs, rule, roadmap, full check

**Files:**

- Modify: `.env.example` (AI block), `docs/deploy.md`, `docs/self-host-ubuntu.md`
- Modify: `CLAUDE.md` ("Rules that are easy to break")
- Modify: `docs/ROADMAP.md` (row 24 → `built`)
- Modify: `docs/phase24/DESIGN.md` (status line + "As built" list)

- [ ] **Step 1: `.env.example`** — replace the AI block:

```bash
# ─── AI (Phase 5, roadmap 24) ─────────────────────────────────────────────────
# Optional. With a key, every org gets a "Server default" integration (Settings → AI) that
# everyone may use until an admin changes its access. Without one, AI works once an org adds
# its own integration in the dashboard.
# ANTHROPIC_API_KEY=
# Default claude-sonnet-5-5; claude-opus-5-5 for harder questions at twice the price.
# AI_MODEL=claude-sonnet-5-5
# More models offered from the same key, comma-separated (AI_MODEL is always first).
# AI_SERVER_MODELS=claude-opus-5-5
# An OpenAI-compatible base URL on a private address (e.g. Ollama on your LAN) is refused
# unless this is true.
# AI_ALLOW_PRIVATE_HOSTS=false
```

- [ ] **Step 2: Deploy docs** — in `docs/deploy.md` and `docs/self-host-ubuntu.md`, where AI env is described, add a short "AI integrations" paragraph: the key is optional; orgs add integrations in Settings → AI; `AI_ALLOW_PRIVATE_HOSTS` for a LAN model server; keys are encrypted with `SECRETS_ENCRYPTION_KEY`, so rotating that key makes stored AI keys unreadable (re-enter them).

- [ ] **Step 3: `CLAUDE.md`** — add under "Rules that are easy to break":

```markdown
- **A new AI feature registers an ability** in `apps/api/src/ai-integrations/abilities.ts` and
  calls `AiRouter.resolve(…, abilityId)` after its permission checks; it never reads an AI key
  or model from env, and it calls the provider only through `AiProvider.stream(target, …)`.
```

- [ ] **Step 4: DESIGN.md** — status `**built** <date>`, and an "As built" list with the six narrowings from the top of this plan, plus the `/me/ai/choices` response carrying `usableIntegrations` and `personalAllowed` (Task 11).

- [ ] **Step 5: ROADMAP.md** — row 24 `built`; bump "Last updated".

- [ ] **Step 6: Full check** — `pnpm typecheck && pnpm lint && pnpm test`, the int specs with `DATABASE_URL_TEST`, and the e2e workflows from Task 13. Then `graphify update .`. Report the real results (counts, any failure verbatim).

- [ ] **Step 7: Commit** (if authorized) — `git commit -m "AI integrations: docs and roadmap (row 24)"` ending with `Co-Authored-By: Kasra Karami <kasra_k2k@yahoo.com>`.
