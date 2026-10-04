/**
 * The jobs module's public surface.
 *
 * The processors, the `Worker` array and `adoptQueueClient` are deliberately NOT here:
 * outside this folder a job is something you ENQUEUE, and the moment another module can
 * call `ExportProcessor.run` directly, "exports go through the queue" stops being true.
 */
export { BULL_CONNECTION, JobsModule } from './jobs.module';
export { runsJobs } from './jobs.runtime';
export { JobsService, JOB_QUEUES, DEFAULT_JOB_OPTIONS, type JobQueues } from './jobs.service';
export {
  JOB_EMAIL_SEND,
  JOB_EXPORT_RENDER,
  JOB_VALIDATE_MODEL,
  QUEUE_EMAIL,
  QUEUE_EXPORT,
  QUEUE_NAMES,
  QUEUE_VALIDATE,
  type EmailJobData,
  type ExportJobData,
  type ExportJobResult,
  type QueueName,
  type ValidateJobData,
} from './queues';
/** The export controller mints the presigned PUT for a client-rendered image against the
 *  same key the server-side formats would have used (doc 01 §4.3). */
export { CORE_EXPORT_FORMATS, exportObjectKey, type CoreExportFormat } from './export-render';
export type { BullConnection } from './bull-connection';
