# Phase 6c: saved connections

Status: **approved 2026-09-30** (the owner asked for it to be built; the four decisions
below are theirs). Roadmap row 6c. It builds on `docs/phase6/DESIGN.md` (§7 was the outline)
and changes nothing in 6a/6b.

**As built (2026-09-30), three changes from the text below:**

- **A read with the saved connection takes no overrides.** `{ saved: true }` means exactly
  as saved. Otherwise an editor could send a new host with "use the saved password" and the
  api would deliver the password to a server they chose. Changing anything is Edit, a `PUT`.
- **Edit keeps a blank secret only while the target is unchanged** (`mergeSecrets`): same
  `host`, `port`, `user`, `ssh`, `ssh_host`, `ssh_port` and `ssh_user`. Otherwise the secret
  must be typed again, for the same reason.
- **Q1 is reversed: the `PUT` comes before the read**, which then uses `{ saved: true }`, so
  one path serves both. A connection that doesn't work stays saved until someone edits it
  (the read's error says why). Project settings show it and offer Forget; editing happens in
  the Sync and Compare dialogs ("Edit connection").

## 0. The decisions

| #   | Question                          | Decision                                                                                                                           |
| --- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| D1  | What "Sync" does                  | **Additive, plus drift.** New objects are imported. Changes and drops show in "Compare with a database". CLAUDE.md rule unchanged. |
| D2  | Scope                             | **One connection per project.**                                                                                                    |
| D3  | Encryption at rest                | **AES-256-GCM under `SECRETS_ENCRYPTION_KEY`**, the key and helper TOTP already uses.                                              |
| D4  | Scheduled drift checks and alerts | **Later**, as a follow-up row. This step is save, "Sync now" and "Compare now".                                                    |

## 1. What the user sees

- The "From a database" form (canvas import, create project, History compare) gets a
  **"Remember this connection for this project"** checkbox.
- Once a connection is saved, those forms open pre-filled. Secret inputs show "saved; leave
  blank to keep", and the saved values never come back to the browser.
- The canvas toolbar and History get **Sync now**: read the database → the usual preview
  (creates, existing tables, rename proposals) → Import. History's **Compare** uses the saved
  connection too.
- Project settings get **Database connection**, showing host, database, user and SSH host,
  when it was saved and by whom, and when it was last used, with **Edit** and **Forget**.

## 2. Data

```prisma
model ProjectConnection {
  projectId   String   @id @map("project_id")
  engineId    String   @map("engine_id")
  /// AES-256-GCM of the whole validated `connection` object, JSON: `iv.tag.ciphertext`.
  encrypted   String
  savedById   String   @map("saved_by_id")
  savedAt     DateTime @default(now()) @map("saved_at")
  lastUsedAt  DateTime? @map("last_used_at")
  project     Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  @@map("project_connections")
}
```

- **The whole object is encrypted, not only the passwords.** Host, user and the SSH host are
  reconnaissance too, and one blob means no column can be missed later. The api decrypts it to
  answer `GET`, and returns only the fields that aren't secret.
- **Which fields are secret** comes from the engine. `ConnectionField` gains
  `secret?: boolean` for `file` fields (`ssh_private_key`, `sslkey`). A `secret`-kind field is
  always secret. CA and client certificates are public, so they're returned.
- Deleting the project deletes the row (cascade). Forget deletes it too, with no soft delete.

## 3. API

Every route carries one marker, and gets a `*.routes.spec.ts` entry.

| Route                                     | Marker                    | Does                                                                                       |
| ----------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /projects/:id/connection`            | `schema:edit`             | The non-secret values, which secret fields are set, saved by/at, last used. 404 if none.   |
| `PUT /projects/:id/connection`            | `sharing:manage`          | Validate (`validateConnection`), merge (blank secret = keep the saved one), encrypt, save. |
| `DELETE /projects/:id/connection`         | `sharing:manage`          | Forget.                                                                                    |
| `POST …/introspect/preview` and `…/drift` | unchanged (`schema:edit`) | Body `{ saved: true }` in place of `{ connection }` reads with the saved one.              |

- **Why `sharing:manage` to save:** a saved connection lets every editor make the api log in
  to that database, so choosing it is a manager's decision, like choosing who gets access.
  Using it is `schema:edit`, the same as importing.
- Using a saved connection runs the **same checks as a typed one**: full view (R21′), the
  kill switch, the rate limit, the SSRF guard on every read (an address can change after it
  was saved) and the host-key pin. Nothing is cached open.
- Invisible is 404: without access to the project, the connection doesn't exist.
- **Audit:** `connection.saved`, `connection.forgotten` (host and database only), and
  `import.introspected` gains `saved: true`.
- **Key rotation:** a row that no longer decrypts answers 409 `connection.undecryptable`
  ("Re-enter the connection's passwords and keys"). There's no re-encryption job;
  `docs/deploy.md` says to re-save connections after changing the key.

## 4. Web

- `connection-form.tsx`: a `saved` prop (the set of secret ids already stored) turns those
  inputs into "saved; leave blank to keep". It sends only what changed.
- `import-dialog.tsx`, `create-project.tsx` and `history-view.tsx` add the checkbox. After a
  successful read with it ticked, they `PUT` the connection. A project being created saves it
  once it exists.
- "Sync now" is the import dialog opened on the database tab, with `saved: true` and the
  form collapsed to a summary line.

## 5. Tests

- Unit: merge rules (blank secret keeps, a new value replaces, an unknown key is refused),
  the secret filter on `GET` (no secret ever serialised, checked on the JSON), and
  undecryptable → 409.
- Routes spec: markers; an editor gets 403 on `PUT`/`DELETE` and can use `saved: true`; a
  non-member gets 404.
- E2E: extend workflow 10: save → reload the dialog (pre-filled, secret shown as saved) →
  Sync with `saved: true` → forget → `GET` 404.

## 6. Open questions (defaults are the recommendation)

| #   | Question                                             | Default                                                                      |
| --- | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| Q1  | Save only after a read succeeded                     | **Yes.** It never stores a connection that has never worked.                 |
| Q2  | Show the saved SSH host-key pin                      | **Yes.** It's a fingerprint, not a secret, and it's how the user checks it.  |
| Q3  | Export or copy a saved connection to another project | **No.** D2 is one per project; re-enter it.                                  |
| Q4  | Scheduled checks (D4)                                | **Next row (6d)**: `upsertJobScheduler` + a notification when drift appears. |
