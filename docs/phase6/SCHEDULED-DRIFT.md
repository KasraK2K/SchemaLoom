# Phase 6d: scheduled drift checks

Status: **proposed 2026-10-01**. The four decisions are the owner's (answered 2026-10-01); the
rest is the recommendation, waiting for approval. Roadmap row 6d. It builds on saved
connections (`SAVED-CONNECTIONS.md`) and the drift check (`DESIGN.md` §6).

## 0. The decisions

| #   | Question    | Decision                                                                                          |
| --- | ----------- | ------------------------------------------------------------------------------------------------- |
| D1  | How often   | **Off, daily or weekly, per project**, set by a project manager. A new connection starts **Off**. |
| D2  | Who is told | **Project managers** (`sharing:manage` on the project).                                           |
| D3  | How         | **In-app notification and email**, through the existing notification and email queues.            |
| D4  | When        | **Only when the drift changes** from the last check, or when checks start or stop failing.        |

## 1. What the user sees

- Project settings → **Database connection** gets **Check for drift: Off / Daily / Weekly**
  (managers only), plus the last result: "In sync", "4 differences" or "Check failed: …",
  with the time.
- When new drift appears, managers get "Storefront: the database has 4 changes the design
  doesn't" in the bell and by email. The link opens History's **Compare**, pre-run with the
  saved connection.
- When checks start failing (bad password, host gone, key rotated), they get one "Drift check
  failed: <reason>", and one more when checks recover. They don't get one per night.

## 2. Data

`ProjectConnection` gains five columns, so there's no new table:

```prisma
driftSchedule     String    @default("off") @map("drift_schedule")   // off | daily | weekly
lastCheckAt       DateTime? @map("last_check_at") @db.Timestamptz(6)
lastCheckStatus   String?   @map("last_check_status")               // in_sync | drift | failed
lastCheckSummary  Json?     @map("last_check_summary")              // counts, or the error code
driftFingerprint  String?   @map("drift_fingerprint")               // sha256 of the sorted diff entries
```

- **Fingerprint:** sha256 over the sorted `(change, objectType, logicalKey)` of the diff's
  entries. D4 compares it with the last one, so the same unresolved drift stays quiet and any
  new or removed difference alerts.
- **Forget** deletes the row, and with it the schedule.

## 3. The job

- **One scheduler, not one per project:** `drift-sweep`, hourly, via `upsertJobScheduler` on
  the maintenance queue (like the audit-retention sweep). Each run picks the connections that
  are due (`daily`: no check in 24 h; `weekly`: none in 7 days), oldest first, at most 20 a run,
  one at a time.
- **Each check is the same read as Compare:** saved connection, re-validated, SSRF guard on
  every run, host-key pin, kill switch (`INTROSPECTION_ENABLED=false` skips the sweep), and
  `SnapshotsService.drift` against the live design. No import is written.
- **No user is acting**, so: the per-user rate limit doesn't apply. A separate budget of 200
  scheduled checks per org per day stops a runaway sweep. The audit row has `actorUserId: null`
  and `scheduled: true`. An engine-gated (423) project is skipped.
- **The notification carries counts only, never object names.** All schema data leaves
  through `VisibilityFilter` (CLAUDE.md), and a job has no viewer to filter for. The link opens
  Compare, which runs with the manager's own permissions and full-view check.
- New notification types in `notificationTypeSchema`: `drift.detected`, `drift.check_failed`,
  `drift.check_recovered`. The email uses the existing email processor, with one template per
  type.

## 4. API and web

| Route                            | Marker           | Does                          |
| -------------------------------- | ---------------- | ----------------------------- |
| `PATCH /projects/:id/connection` | `sharing:manage` | `{ driftSchedule }`           |
| `GET /projects/:id/connection`   | unchanged        | adds schedule and last result |

- Web: the select and the last result in `SavedConnectionSettings`. History reads
  `?compare=saved` to open Compare and run it with the saved connection.

## 5. Tests

- Unit: due selection (daily/weekly boundaries, oldest first, the 20 cap), fingerprint
  stability (entry order doesn't matter), and the D4 state machine (in_sync → drift notifies;
  drift → same drift doesn't; drift → different drift does; failed once notifies; recovered
  notifies).
- A notification body never contains an entity or field name (checked on the JSON).
- Routes spec for `PATCH`. E2E: set Daily, run the sweep job directly, see one
  notification, run again, see no second one.

## 6. Open questions (defaults are the recommendation)

| #   | Question                              | Default                                                                         |
| --- | ------------------------------------- | ------------------------------------------------------------------------------- |
| Q1  | Time of the daily check               | **Whenever the hourly sweep finds it due.** No per-project time picker.         |
| Q2  | Per-user "don't email me about drift" | **Later**, with notification preferences. In-app always shows.                  |
| Q3  | Notify after how many failures        | **First failure.** A transient blip costs one notification and one "recovered". |
| Q4  | Keep a history of check results       | **No.** Only the last result; the audit log holds each run.                     |
