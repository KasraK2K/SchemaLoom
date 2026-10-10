# Phase 24: AI integrations (roadmap 24)

Status: **approved** 2026-10-10. Decisions §1 were made in the design session the same day. Plan: `docs/phase24/PLAN.md`.

The goal: AI works without an `ANTHROPIC_API_KEY` in `.env`. An org adds its own AI
integrations in the dashboard and decides who may use them, per project, per member, per
member in a project, or for everyone. A member can add a personal integration when the org
allows it. Every AI ability (chat, schema draft, doc drafts, and every ability added later)
picks its integration and model through one resolver, with org and project defaults that an
admin can lock.

Today `AiProvider` (`apps/api/src/ai/ai.provider.ts`) is Anthropic-only, reads
`ANTHROPIC_API_KEY`/`AI_MODEL` once at boot, and without a key every AI route answers 503
`ai_not_configured`.

## 1. Decisions

| #   | Question                                   | Decision                                                                                                                                                                                           |
| --- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Providers                                  | `anthropic`, `openai`, `gemini`, `openai_compatible` (custom base URL: Azure OpenAI, OpenRouter, Ollama, vLLM, LM Studio, …).                                                                     |
| D2  | `.env` key                                 | Stays, as the **server default**: one built-in, read-only integration per org. Absent key = the integration is hidden. It keeps every Anthropic feature.                                         |
| D3  | `ai:use` vs integration access             | Separate and both required. `ai:use` + the project switch decide whether the AI may see the project; integration access decides which keys/models a call may spend. A personal key never bypasses either. |
| D4  | Personal integrations                      | Org setting `ai.allowPersonalIntegrations`, **off** by default, owner/admin decides, with an optional provider-type allowlist `ai.personalProviders`.                                             |
| D5  | Access rules                               | Allow-only grants on an org integration, scoped `*`, project, member, or member-in-project. No deny rules.                                                                                       |
| D6  | Model per ability                          | Most specific choice wins (§3.2); org and project defaults can be **locked** per ability.                                                                                                       |
| D7  | Provider layer                             | Two official SDKs behind the existing `AiProvider` boundary: `@anthropic-ai/sdk` (today's path, unchanged) and `openai` (OpenAI, OpenAI-compatible, Gemini via Google's OpenAI-compatible endpoint). |
| D8  | Model list                                 | Fetched by "Test connection"; the admin ticks the allowed models, or types an id by hand for servers that don't list theirs.                                                                     |
| D9  | Background jobs                            | Resolve at enqueue as the requester; re-check usability when the job runs.                                                                                                                       |
| D10 | Budgets / quotas                           | Deferred. Usage is recorded per integration and model (§2.4) so a budget can be added later.                                                                                                     |
| D11 | MCP (row 21)                               | Unaffected: it uses the developer's own agent, never a server key.                                                                                                                               |

What a non-Anthropic provider loses (shown in the UI, §5.4):

| Feature used today                     | Anthropic | OpenAI                         | Gemini             | OpenAI-compatible         |
| -------------------------------------- | --------- | ------------------------------ | ------------------ | ------------------------- |
| Prompt caching of the schema prefix    | explicit  | automatic for a stable prefix  | implicit           | server-dependent, usually none |
| Adaptive thinking                      | yes       | `reasoning_effort` where accepted | `reasoning_effort` where accepted | usually none        |
| Server-side fallback on a policy decline | yes     | no (a decline is a refusal)    | no                 | no                        |
| Streaming, usage, refusal detection    | yes       | yes                            | yes                | mostly; usage may be absent |

These rows are from the providers' docs as known on 2026-10-10; re-check each before the
adapter is written (§4).

## 2. Data model

Keys are encrypted with `encryptSecret` (AES-256-GCM under `SECRETS_ENCRYPTION_KEY`), like
`AuditStream`'s secrets, and are never returned by any route or written to the audit log.

### 2.1 `ai_integrations`

| column                                   | notes                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `id`                                     | cuid                                                                                                          |
| `organization_id` / `owner_user_id`      | exactly one set (CHECK). Org integration, or personal. A personal one belongs to the **user**, not to an org; each org's policy (D4) decides whether it is usable there. Both cascade on delete. |
| `source`                                 | `server` \| `custom` (CHECK). `server` rows have `organization_id` set and no key.                           |
| `provider`                               | `anthropic` \| `openai` \| `gemini` \| `openai_compatible` (CHECK)                                            |
| `name`                                   | display name                                                                                                  |
| `base_url`                               | `openai_compatible` only (CHECK). Validated like the SIEM endpoint: private/internal hosts refused unless `AI_ALLOW_PRIVATE_HOSTS=true`. |
| `api_key_enc`                            | null for `server`; optional for `openai_compatible` (a local Ollama needs none); required otherwise           |
| `key_hint`                               | last 4 characters of the key, for display                                                                     |
| `allowed_models text[]`                  | non-empty for `custom`                                                                                         |
| `status`, `last_error`, `last_checked_at` | from "Test connection": `unchecked` \| `ok` \| `failing`                                                     |
| `created_by`, `created_at`, `updated_at` |                                                                                                               |

**The server row.** One `source='server'`, `provider='anthropic'` row per org, created by the
migration for every existing org and by org creation for new ones. It exists so grants and
choices reference it with ordinary foreign keys; its key and models come from env at call
time (`ANTHROPIC_API_KEY`, `AI_MODEL`, and the new optional `AI_SERVER_MODELS`, a
comma-separated list offered from the same key). It cannot be edited or deleted, only granted.
With no env key it is hidden from every list and is never usable.

### 2.2 `ai_integration_grants`

Who may use an **org** integration. A personal integration is usable only by its owner and
has no grants.

| column           | notes                                   |
| ---------------- | --------------------------------------- |
| `integration_id` | FK, cascade                             |
| `project_id?`    | FK, cascade                             |
| `user_id?`       | FK, cascade                             |
| `created_by`, `created_at` |                               |

Both null = `*`; project only = everyone with access to that project; user only = that member
in every project; both = that member in that project. Unique on
`(integration_id, project_id, user_id)` with nulls not distinct. The project must belong to
the integration's org (checked on write).

### 2.3 `ai_ability_choices`

| column            | notes                                                                            |
| ----------------- | -------------------------------------------------------------------------------- |
| `ability`         | an id from the ability registry (§3.3); checked on write                        |
| `organization_id` | FK, cascade                                                                      |
| `project_id?`     | FK, cascade                                                                      |
| `user_id?`        | FK, cascade                                                                      |
| `integration_id`  | FK, cascade                                                                      |
| `model`           | must be in the integration's models when written                                 |
| `locked`          | boolean; only on rows with `user_id` null (CHECK)                                |
| `updated_by`, `updated_at` |                                                                         |

Scopes: org default (`project_id`, `user_id` null), project default (`project_id`), member
everywhere (`user_id`), member in project (both). Unique on
`(organization_id, ability, project_id, user_id)` with nulls not distinct.

### 2.4 Changes to existing tables

- `organizations.settings.ai`: `allowPersonalIntegrations` (default false) and
  `personalProviders` (string array, empty = any of D1). Read with the same
  malformed-reads-as-default rule as `aiSettings()`.
- `AiMessage` and `DocDraft` gain `integration_id` (FK, on delete SET NULL) beside the model and
  token columns they already carry.
- The doc-draft job payload carries `{ integrationId, model }`.

### 2.5 What deletion does

Deleting an integration cascades its grants and choices. Revoking a grant leaves choice rows
in place, and resolution skips them. Removing a model from `allowed_models` makes choices
naming it skip too. Either way the next call falls to the next step: fewer options, nothing
broken. Deleting a user cascades their personal integrations, grants and choices.

## 3. Resolution and permission checks

### 3.1 Where it sits

A new `AiRouter.resolve(subject, projectId, ability)` returns
`{ integration, model, capabilities, client }` or throws. `AiService` calls it where it calls
`assertConfigured()` today, keeping the existing order so a permission answer never depends
on configuration:

1. not visible → **404**
2. no `ai:use` → **403** `forbidden`
3. project AI switch off → **403** `ai_disabled`
4. rate limit → **429** `ai_rate_limited` (unchanged)
5. `resolve` → **503** `ai_no_model` when nothing is usable (replaces `ai_not_configured`),
   **503** `ai_locked_model_unavailable` (§3.2), **422** `ai_context_too_small` (§4.3)

**Read routes stop answering 503.** Listing and opening threads, listing, rejecting and
accepting doc drafts call no model, so they no longer call the resolver. History stays
readable after a key is removed. Only posting a message, drafting a schema and enqueuing doc
drafts resolve.

### 3.2 The rules

**Usable integrations** for member U in project P of org O:

- an **org integration** with at least one grant matching `*`, P, U or (U, P), and for
  `source='server'` an env key present. U's access to P is already established by steps 1–3,
  so a project grant gives nothing to someone who cannot see the project.
- a **personal integration** owned by U, when O has `allowPersonalIntegrations` on and its
  provider is in `personalProviders` (or that list is empty).

**The choice** for an ability, first match wins:

1. locked project default
2. locked org default (a lock skips steps 3–4)
3. U's choice in P
4. U's choice everywhere
5. project default
6. org default
7. the server row with `AI_MODEL`

A step is skipped when it has no row, its integration is not usable, or its model is no
longer allowed. **A locked step that is not usable is an error**, 503
`ai_locked_model_unavailable`, never a skip: falling through would get around the lock.

### 3.3 The ability registry

One list in `apps/api/src/ai-integrations/abilities.ts`:

```ts
{ id: 'chat', label: 'Assistant chat', strictOutput: false, background: false },
{ id: 'schema_draft', label: 'Describe it, get a schema', strictOutput: true, background: false },
{ id: 'doc_drafts', label: 'Draft docs', strictOutput: true, background: true },
```

A new AI feature adds one entry and calls `AiRouter.resolve` with its id. It gets
resolution, locks, the settings rows and the in-feature picker with no other change. It never
reads an AI key or model from env (rule added to `CLAUDE.md`).

### 3.4 Background jobs

`enqueueDocDrafts` resolves as the requester and stores `{ integrationId, model }` in the job.
`runDocDraftJob` re-checks that the integration is still usable by that user with that model
(the same §3.2 usability rule; it does not re-pick). If not, it ends with `{ drafted: 0 }`
and a reason, as the not-configured case ends today.

### 3.5 Who manages what

| What                                                                                    | Marker                                                     |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| org integrations, their grants, org defaults and locks, personal-integration policy     | `@Authenticated` + the owner/admin check in the service, as `PATCH /organizations/:orgSlug/settings` does today |
| project defaults and locks                                                              | `@RequirePermission('sharing:manage', { project })`, the atom that guards project settings and the AI switch today |
| personal integrations and your own choices                                              | `@Authenticated`; only your own rows; another user's id is **404** |
| what you can use in a project (`/ai/options`)                                           | `@RequireProjectAccess`; lists only what is usable by you, never other people's grants |

Admins manage the org's integrations; that does not widen project visibility (R13): an admin
granting an integration to a project does not see that project.

### 3.6 Audit

Written to the audit log (and so to the SIEM stream): `ai_integration.created`, `.updated`,
`.key_rotated`, `.deleted`, `.tested`; `ai_integration_grant.added`, `.removed`;
`ai_choice.set`, `.cleared` (with `locked`); `org.ai_policy_changed`. Personal integrations
audit under the owner. Key values never appear, only `key_rotated`.

## 4. Provider adapters

### 4.1 Boundary

`AiProvider`'s contract (`AiRequest` → `AiResult`, `stream(request, onText, signal)`) is
unchanged, so `AiService`'s prompts are untouched. It gains the resolved target as an
argument instead of reading env in its constructor, and becomes a switch on `provider`:

- **`anthropic`**: today's code, with key, model and optional base URL from the integration
  (the server row passes env values). Keeps `cache_control`, adaptive thinking and
  `fallbacks: 'default'` where the model supports it, as today.
- **`openai` | `gemini` | `openai_compatible`**: one function on the `openai` SDK's streaming
  chat completions. `gemini` is a fixed base URL (Google's OpenAI-compatible endpoint).
  - `prefix` then `instructions` as two system messages, prefix first, for prefix caching
  - `maxTokens` → `max_completion_tokens`
  - thinking → `reasoning_effort` where the model accepts it, otherwise omitted
  - `finish_reason` `content_filter` → `stopReason: 'refusal'`, `length` → `'max_tokens'`, so
    every existing refusal and truncation check holds
  - usage → `tokensIn`/`tokensOut`, null when absent

A client is built per call; decrypted keys are not cached beyond the call. A rotation applies
on the next call. Provider error bodies are scrubbed of anything matching the key before
they are logged or stored in `last_error`.

### 4.2 Capabilities

Each adapter exports a static record `{ caching, thinking, fallback }` and, where known, a
context size per model id. Unknown models get `contextTokens: null`. The UI reads these for
its hints (§5.4).

### 4.3 Context guard

When the model's context size is known and smaller than the estimated prompt (the existing
`ir-size` estimate plus the transcript plus `maxTokens`), the call fails with 422
`ai_context_too_small` before reaching the provider. Unknown size = no guard; the provider's
own error is mapped to the same code.

### 4.4 Test connection

`POST …/integrations/:id/test`: lists models (or makes a one-token call when the provider has
no list endpoint), 10 s timeout, stores `status`, `last_error`, `last_checked_at`, and returns
the fetched model ids. It never changes `allowed_models` by itself.

## 5. API and UI

### 5.1 Routes

A new `apps/api/src/ai-integrations` module. Every route carries exactly one marker and is
listed in a `*.routes.spec.ts`; bodies are zod-validated like `ai.dto.ts`.

| Route                                                                       | Marker                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------- |
| `GET, POST /organizations/:orgSlug/ai/integrations`; `PATCH, DELETE …/:id`             | `@Authenticated` + owner/admin (§3.5)             |
| `POST /organizations/:orgSlug/ai/integrations/:id/test`                                | `@Authenticated` + owner/admin (§3.5)             |
| `GET, POST /organizations/:orgSlug/ai/integrations/:id/grants`; `DELETE …/grants/:grantId` | `@Authenticated` + owner/admin (§3.5)         |
| `GET, PUT, DELETE /organizations/:orgSlug/ai/choices` (org defaults, locks)            | `@Authenticated` + owner/admin (§3.5)             |
| `PATCH /organizations/:orgSlug/settings` (existing): `ai.allowPersonalIntegrations`, `ai.personalProviders` | existing marker            |
| `GET, PUT, DELETE /projects/:projectId/ai/choices` (project defaults, locks) | `@RequirePermission('sharing:manage', { project: 'projectId' })` |
| `GET, POST /me/ai/integrations`; `PATCH, DELETE …/:id`; `POST …/:id/test`   | `@Authenticated`                                  |
| `GET, PUT, DELETE /me/ai/choices` (optional `projectId`)                    | `@Authenticated`                                  |
| `GET /projects/:projectId/ai/options`                                       | `@RequireProjectAccess('projectId')`              |
| `GET /ai/abilities`                                                         | `@Authenticated`                                  |

Keys are write-only: responses carry `keyHint` only; `PATCH { apiKey }` rotates. The server
row is returned with `source: 'server'`, its env models, and no key fields; writes to it
other than grants answer 409 `ai_server_integration_readonly`.

`/ai/options` returns, per ability: the usable `{ integrationId, name, provider, source,
models[], capabilities }`, the resolved choice and the step it came from, and the lock (if
any) with who set it (org or project).

### 5.2 Org settings → AI (`/[orgSlug]/settings/ai`, added to `org-settings-nav.tsx`)

- **Integrations**: server default first (badge "Server · full features"), then each by
  provider, status dot and model count. "Add integration": provider, name, base URL
  (OpenAI-compatible only), key, **Test & fetch models**, tick allowed models or add one by
  hand.
- **Access**, per integration: grant list, "Add access" with Everyone / Project / Member /
  Member in project.
- **Defaults per ability**: integration, model, lock.
- **Personal integrations**: the allow toggle and the provider checklist.

### 5.3 Project settings dialog → AI tab

Next to the existing AI on/off switch: project defaults and locks per ability (same row
component as the org page), showing any org lock as read-only.

### 5.4 User settings → AI (`/settings/ai`, beside Security)

Personal integrations (same add dialog), choices per ability "everywhere" and per-project
overrides. When an org disallows personal integrations, a note says so for that org.

### 5.5 In the features

The AI panel, the describe dialog and the doc-draft action get a small model picker reading
`/ai/options`: "Claude Sonnet 5.5 · Server default". Picking saves a member-in-project choice.
Locked: shown disabled, "Set by your admin". No model: the empty state links to the org AI
page for admins, or to the user's AI page for members when personal integrations are allowed,
otherwise "Ask an admin to add an AI integration". Capability hints from §4.2: "No fallback on
refusal", "Context 32k, may be too small for large selections", and for `strictOutput`
abilities on an unknown or small model a warning before the call.

No provider or ability id is hard-coded in `apps/web`; both lists come from the API, as engines
come from `GET /engines`.

## 6. Migration and deploy

- The Prisma migration creates the tables, then for every org a `source='server'` row and a
  `*` grant on it. A deploy with `ANTHROPIC_API_KEY` set behaves exactly as before: everyone
  with `ai:use` gets `AI_MODEL`. Without the key nothing changes until an integration is added.
- No new required env. New optional: `AI_SERVER_MODELS`, `AI_ALLOW_PRIVATE_HOSTS` (default
  false). `SECRETS_ENCRYPTION_KEY` is already required.
- New dependency: `openai` in `apps/api` (via the catalog).
- `.env.example`, `docs/deploy.md` and `docs/self-host-ubuntu.md` get an "AI integrations"
  note, including `AI_ALLOW_PRIVATE_HOSTS` for a LAN Ollama.
- `CLAUDE.md` gains: "A new AI feature registers an ability and calls `AiRouter.resolve`; it
  never reads an AI key or model from env."

## 7. Testing

- **Resolver** (`ai-router.spec.ts`, table-driven): each of the seven steps winning; a lock
  skipping member choices; a locked step unusable → 503, not a fall-through; a revoked grant
  and a removed model skipped; personal integrations with the policy off and with the provider
  outside the allowlist; the server row with no env key; a project grant not reaching a member
  without project access; the job re-check failing after a grant is revoked.
- **Adapters**: request mapping, stop-reason and usage mapping for the OpenAI path against a
  stub client; key scrubbing of error bodies. Existing Anthropic specs keep passing.
- **Routes**: a `*.routes.spec.ts` per new controller; the boot sweep green; another user's
  personal rows → 404; keys absent from every response and audit row; the server row
  read-only; a grant to a project in another org refused.
- **`ai.service.spec.ts`**: overrides `AiRouter.resolve` instead of `AiProvider`; read routes
  no longer 503.
- **e2e**: `e2e/scripts/fake-anthropic.ts` also answers `/v1/models` and streaming
  `/v1/chat/completions`. New workflow: an admin adds an OpenAI-compatible integration on the
  fake, grants it to one member in one project and locks it for chat; that member's chat
  reaches the fake OpenAI endpoint; a member without the grant sees the no-model empty state;
  the admin allows personal integrations, the member adds one, and the lock still wins.
  Workflow 3 stays on the server-default path.

## 8. Out of scope

Budgets and quotas (D10), deny rules, per-ability fallback models on non-Anthropic providers,
Bedrock/Vertex, Gemini explicit context caching, sharing a personal integration with others,
and group-scoped grants (add when asked: one more nullable column on the grant).
