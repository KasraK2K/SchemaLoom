import { Injectable } from '@nestjs/common';
import { PermissionResolver } from '../access';
import { SnapshotsService } from '../snapshots';
import { StorageService } from '../storage';
import type { ImportJobData, ImportJobResult } from './queues';

/** Doc 00 Q22's ceiling for the queued path; the synchronous one stops at 5 MB. */
export const QUEUED_IMPORT_MAX_BYTES = 50_000_000;

export const importObjectKey = (projectId: string, id: string): string =>
  `imports/${projectId}/${id}.sql`;

/**
 * The large-import job. It is the synchronous import run later: the SAME
 * `SnapshotsService.importSource` (merge, batching, R21′), with the permission map
 * resolved when the job RUNS, so an editor demoted between upload and run is refused.
 */
@Injectable()
export class ImportProcessor {
  constructor(
    private readonly resolver: PermissionResolver,
    private readonly snapshots: SnapshotsService,
    private readonly storage: StorageService,
  ) {}

  async run(data: ImportJobData): Promise<ImportJobResult> {
    const { projectId, subject, storageKey, renames = [] } = data;
    const [map, skel] = await Promise.all([
      this.resolver.resolveProject(subject, projectId),
      this.resolver.skeleton(projectId),
    ]);
    this.resolver.assertAll(map, skel, [{ type: 'project', id: projectId }], 'schema:edit');

    const source = (await this.storage.get(storageKey)).toString('utf8');
    const { report, existing } = await this.snapshots.importSource(
      {
        projectId,
        subject,
        actorUserId: subject.kind === 'user' ? subject.userId : null,
        map,
        skel,
      },
      source,
      QUEUED_IMPORT_MAX_BYTES,
      renames,
    );
    // Only on success: a retry needs the source again.
    await this.storage.delete(storageKey);
    return { report, existing };
  }
}
