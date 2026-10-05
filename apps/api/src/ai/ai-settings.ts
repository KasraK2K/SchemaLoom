import { ForbiddenException } from '@nestjs/common';
import type { ProjectPermissionMap } from '../access';

/** `projects.settings.ai`, defaults true (doc 02 `projectSettingsShape`). Read here; the
 *  PATCH that writes it is `ProjectsController`'s. Anything malformed reads as the default. */
export function aiSettings(settings: unknown): { enabled: boolean; includeDocsInContext: boolean } {
  const ai = (settings as { ai?: { enabled?: unknown; includeDocsInContext?: unknown } } | null)
    ?.ai;
  return {
    enabled: ai?.enabled !== false,
    includeDocsInContext: ai?.includeDocsInContext !== false,
  };
}

/**
 * Phase 21 §3 — what an agent token needs at the project, in `AiService`'s order and codes:
 * `ai:use`, then the kill switch. Checked when the token is created and on every call to a
 * route outside `AiService` (validate, saved queries), so AI off means no schema reaches an
 * agent either.
 */
export function assertAgentAllowed(map: ProjectPermissionMap, settings: unknown): void {
  if (!map.projectAtoms.has('ai:use')) {
    throw new ForbiddenException({ code: 'forbidden', atom: 'ai:use' });
  }
  if (!aiSettings(settings).enabled) throw new ForbiddenException({ code: 'ai_disabled' });
}
