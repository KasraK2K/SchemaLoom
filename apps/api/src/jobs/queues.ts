import type { Subject } from '../access';
import type { ConfirmedRename } from '../snapshots';

/**
 * Doc 01 §4.4 — the three Phase 1 queues, in-process.
 *
 * There is no `apps/worker` in Phase 1 and its absence is deliberate (doc 01 §2): whether
 * the processors run beside the API or in their own deployment is a LOAD question, not a
 * design one, and the answer changes without a line of this file changing — a separate
 * process imports the same `JobsModule` and stops enqueuing.
 */
export const QUEUE_EXPORT = 'export';
export const QUEUE_EMAIL = 'email';
export const QUEUE_VALIDATE = 'validate';
export const QUEUE_IMPORT = 'import';

export const QUEUE_NAMES = [QUEUE_EXPORT, QUEUE_EMAIL, QUEUE_VALIDATE, QUEUE_IMPORT] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/**
 * Job names, distinct from queue names. BullMQ reports the name on every event and every
 * failed-job row, so `export.render` in a log line says what was being done and not only
 * where it was queued.
 */
export const JOB_EXPORT_RENDER = 'export.render';
export const JOB_EMAIL_SEND = 'email.send';
export const JOB_VALIDATE_MODEL = 'validate.model';
export const JOB_IMPORT_SQL = 'import.sql';

/**
 * The export job carries a `(projectId, subject)` pair, never a model.
 *
 * Two reasons, both load-bearing. A `RedactedModel` cannot survive JSON — the brand is
 * phantom, so what comes back out of Redis is an unbranded object and the type stops
 * meaning anything. And permissions are re-resolved when the job RUNS: a grant revoked
 * between enqueue and render is honoured, which it would not be if the payload were a
 * snapshot of what the requester could see at enqueue time.
 */
export interface ExportJobData {
  /** The `export_jobs` row this job reports into. */
  readonly exportJobId: string;
  readonly projectId: string;
  readonly subject: Subject;
  /** `ir-json`, `markdown`, `pdf`, or an `ExportFormatDescriptor.id` the engine declares. */
  readonly format: string;
  /** DDL switches from `POST /projects/:id/exports`; the engine's defaults otherwise. */
  readonly options?: ExportDdlOptions;
}

export interface ExportDdlOptions {
  readonly includeComments?: boolean;
  readonly includeDrops?: boolean;
  readonly includeIfNotExists?: boolean;
}

export interface ExportJobResult {
  readonly storageKey: string;
  readonly sizeBytes: number;
  /** Doc 03 §10.3 — redaction removed or altered something. A boolean, never a count:
   *  doc 05 §8.4 L8 makes an aggregate over hidden objects a leak in itself. */
  readonly incomplete: boolean;
}

/** The two Phase 1 transactional emails (`MailService`), off the request path. */
export type EmailJobData =
  | { readonly kind: 'verify-email'; readonly to: string; readonly name: string; readonly token: string }
  | { readonly kind: 'password-reset'; readonly to: string; readonly name: string; readonly token: string };

export interface ValidateJobData {
  readonly projectId: string;
  readonly subject: Subject;
}

/**
 * Doc 00 Q22 — an import over the synchronous 5 MB cap. The source waits in object storage
 * (a 50 MB payload in Redis would sit in a `noeviction` instance), and permissions are
 * re-resolved when the job runs, exactly as for an export.
 */
export interface ImportJobData {
  readonly projectId: string;
  readonly subject: Subject;
  readonly storageKey: string;
  /** Phase 4 §2.1 — confirmed renames, validated again when the job runs. */
  readonly renames?: readonly ConfirmedRename[];
}

/** What `GET .../import/jobs/:id` hands back once the job is done. */
export interface ImportJobResult {
  readonly report: unknown;
  readonly existing: readonly string[];
}
