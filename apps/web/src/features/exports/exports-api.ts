import { z } from 'zod';
import { ApiError, apiFetch } from '@/lib/api-client';

/**
 * The export routes (`apps/api/src/jobs/exports.controller.ts`). Server formats are
 * POSTed, then polled until the row is `done`; `png`/`svg` are rendered here and PUT to
 * the presigned URL the POST returns, then marked complete.
 */

export const exportJobSchema = z.object({
  id: z.string(),
  format: z.string(),
  status: z.enum(['queued', 'running', 'done', 'failed']),
  error: z.string().nullable(),
  uploadUrl: z.string().optional(),
  downloadUrl: z.string().optional(),
});
export type ExportJob = z.infer<typeof exportJobSchema>;

export type ImageFormat = 'png' | 'svg';

export const IMAGE_CONTENT_TYPES: Readonly<Record<ImageFormat, string>> = {
  png: 'image/png',
  svg: 'image/svg+xml',
};

const POLL_MS = 1000;
/** A render that has not finished in two minutes is stuck, not slow. */
const POLL_LIMIT = 120;

const startExport = async (projectId: string, body: object): Promise<ExportJob> =>
  exportJobSchema.parse(
    await apiFetch<unknown>(`/projects/${encodeURIComponent(projectId)}/exports`, {
      method: 'POST',
      body,
    }),
  );

const getExport = async (id: string): Promise<ExportJob> =>
  exportJobSchema.parse(await apiFetch<unknown>(`/exports/${encodeURIComponent(id)}`));

/** Queue a server-rendered format and wait for its download link. */
export async function runServerExport(projectId: string, format: string): Promise<string> {
  let job = await startExport(projectId, { format });
  for (let i = 0; i < POLL_LIMIT && job.status !== 'done' && job.status !== 'failed'; i++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    job = await getExport(job.id);
  }
  return downloadUrlOf(job);
}

/** Upload a browser-rendered image and return its download link. */
export async function runImageExport(
  projectId: string,
  format: ImageFormat,
  blob: Blob,
): Promise<string> {
  const job = await startExport(projectId, { format, sizeBytes: blob.size });
  if (job.uploadUrl === undefined) throw new Error('The server did not return an upload URL.');
  // Content-Type and Content-Length are signed into the URL: send exactly the declared type.
  const put = await fetch(job.uploadUrl, {
    method: 'PUT',
    body: blob,
    headers: { 'Content-Type': IMAGE_CONTENT_TYPES[format] },
  });
  if (!put.ok) throw new Error(`The upload failed (${String(put.status)}).`);
  const done = exportJobSchema.parse(
    await apiFetch<unknown>(`/exports/${encodeURIComponent(job.id)}/complete`, { method: 'POST' }),
  );
  return downloadUrlOf(done);
}

function downloadUrlOf(job: ExportJob): string {
  if (job.status === 'done' && job.downloadUrl !== undefined) return job.downloadUrl;
  if (job.status === 'failed') throw new Error(job.error ?? 'The export failed.');
  throw new Error('The export is taking too long. Try again.');
}

/** What the menu shows for a failure. A 403 is the one the user can act on. */
export function exportErrorMessage(caught: unknown): string {
  if (caught instanceof ApiError && caught.status === 403) return "You don't have export access.";
  if (caught instanceof Error && caught.message !== '') return caught.message;
  return 'The export failed. Try again.';
}

/** The signed URL answers `Content-Disposition: attachment`, so this saves, not navigates. */
export function startDownload(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}
