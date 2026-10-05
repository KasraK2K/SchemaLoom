import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DOC_TARGET_TYPES,
  richTextSchema,
  structuredDocSchema,
  type DocTargetType,
} from '@schemaloom/contracts';
import type { RedactedModel } from '@schemaloom/schema-model';
import {
  PermissionResolver,
  VisibilityFilter,
  type ProjectPermissionMap,
  type ProjectSkeleton,
  type Subject,
} from '../access';
import { Prisma, type Doc } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SchemaCommits, SchemaLoader } from '../schema';
import { authorityRef, docPlainText, sanitizeRichText, targetVisible } from './docs-rules';

export interface DocView {
  targetType: DocTargetType;
  targetId: string;
  /** Sanitised TipTap JSON (StarterKit nodes only). */
  content: unknown;
  /** `structuredDocSchema`, entity / field only; null otherwise or when never set. */
  structured: unknown;
  plainText: string;
  /** 0 for a target that has never been documented; send it back as `version`. */
  version: number;
  updatedAt: string | null;
  /** `docs:edit` at the target (a field answers at its entity). */
  canEdit: boolean;
}

/** `importDocs`' input: SQL comment text, or a copied doc (org templates, 12c). */
export type ImportedDocInput = { targetType: 'area' | 'entity' | 'field'; targetId: string } & (
  { text: string } | { content: unknown; structured: unknown }
);

/** One caller's view of one project, resolved once per request. */
interface CallerView {
  readonly subject: Subject;
  readonly projectId: string;
  readonly map: ProjectPermissionMap;
  readonly skel: ProjectSkeleton;
  readonly redacted: RedactedModel;
}

const EMPTY_DOC = { type: 'doc', content: [] } as const;

const notFound = (resourceType: string, id: string): NotFoundException =>
  new NotFoundException({ code: 'not_found', resourceType, id });

/**
 * Phase 5 DESIGN §1, doc 04 §8.10, doc 05 `docs:edit`.
 *
 * Visibility is read off the caller's REDACTED model, like saved queries and comments: a
 * target that did not survive redaction (hidden entity, stub, hidden or masked field, an
 * area with nothing visible) is 404 on every route and absent from the list (L8). A
 * visible target without `docs:edit` is 403 — existence is already disclosed.
 *
 * `doc` is server-owned in the IR (§8.3): this module derives `plainText`, the loader
 * derives the excerpt from it, and the write emits a `SchemaOperationResult`-shaped frame
 * so every subscribed canvas merges the refreshed `DocRef` through its one merge path.
 */
@Injectable()
export class DocsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly loader: SchemaLoader,
    private readonly filter: VisibilityFilter,
    private readonly resolver: PermissionResolver,
    private readonly commits: SchemaCommits,
  ) {}

  /** Docs mode: every doc row whose target the caller can see. */
  async list(
    subject: Subject,
    projectId: string,
    map?: ProjectPermissionMap,
  ): Promise<{ docs: DocView[] }> {
    const view = await this.view(subject, projectId, map);
    const rows = await this.prisma.doc.findMany({
      where: { projectId },
      orderBy: [{ targetType: 'asc' }, { targetId: 'asc' }],
    });
    return {
      docs: rows
        .filter((row) => targetVisible(view.redacted, projectId, row.targetType, row.targetId))
        .map((row) =>
          toView(
            row,
            row.targetType,
            row.targetId,
            this.canEdit(view, row.targetType, row.targetId),
          ),
        ),
    };
  }

  /** One doc; an invisible target is 404, a visible one never documented is an empty doc. */
  async get(
    subject: Subject,
    projectId: string,
    targetType: string,
    targetId: string,
    map?: ProjectPermissionMap,
  ): Promise<DocView> {
    const view = await this.view(subject, projectId, map);
    const type = this.visibleTarget(view, targetType, targetId);
    const row = await this.prisma.doc.findFirst({
      where: { projectId, targetType: type, targetId },
    });
    return toView(row, type, targetId, this.canEdit(view, type, targetId));
  }

  /**
   * The ONE docs write path: the PUT route and the AI track's draft accept both land here.
   *
   * `version` is optimistic: the version the caller last read (0 for a never-documented
   * target). A mismatch is `409 stale_version` carrying the current doc. Absent, the write
   * is last-write-wins. `structured` absent keeps the stored facts; null clears them.
   */
  async write(
    subject: Subject,
    projectId: string,
    targetType: 'project' | 'area' | 'entity' | 'field',
    targetId: string,
    // The agreed cross-track signature; `| null` documents that null clears the facts.
    // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
    body: { content: unknown; structured?: unknown | null; version?: number },
  ): Promise<DocView> {
    if (subject.kind !== 'user') throw notFound(targetType, targetId);
    const view = await this.view(subject, projectId);
    const type = this.visibleTarget(view, targetType, targetId);
    if (!this.canEdit(view, type, targetId)) {
      throw new ForbiddenException({ code: 'forbidden', resourceType: 'doc' });
    }

    const content = parseContent(body.content);
    const structured = parseStructured(type, body.structured);
    const data = {
      content: content as Prisma.InputJsonValue,
      plainText: docPlainText(content),
      updatedById: subject.userId,
      ...(structured === undefined
        ? {}
        : {
            structured: structured === null ? Prisma.DbNull : (structured as Prisma.InputJsonValue),
          }),
    };

    const existing = await this.prisma.doc.findFirst({
      where: { projectId, targetType: type, targetId },
    });
    const stale = async (): Promise<never> => {
      const current = await this.prisma.doc.findFirst({
        where: { projectId, targetType: type, targetId },
      });
      throw new ConflictException({
        code: 'stale_version',
        current: toView(current, type, targetId, true),
      });
    };

    if (existing === null) {
      if (body.version !== undefined && body.version !== 0) return stale();
      try {
        await this.prisma.doc.create({
          data: { id: randomUUID(), projectId, targetType: type, targetId, ...data, version: 1 },
        });
      } catch (error) {
        // A concurrent first write won the `(target_type, target_id)` unique index.
        if ((error as { code?: unknown }).code === 'P2002') return stale();
        throw error;
      }
    } else {
      const expected = body.version ?? existing.version;
      const { count } = await this.prisma.doc.updateMany({
        where: { id: existing.id, version: expected },
        data: { ...data, version: { increment: 1 } },
      });
      if (count === 0) return stale();
    }

    await this.broadcast(projectId, subject.userId);
    const row = await this.prisma.doc.findFirst({
      where: { projectId, targetType: type, targetId },
    });
    return toView(row, type, targetId, true);
  }

  /**
   * SQL import's comments (`ImportResult.docs`), written as docs ADDITIVELY like the rest of
   * an import: a target that already has a doc keeps it, and only targets the caller can
   * see and holds `docs:edit` on are written. One read, one insert, one broadcast.
   * Roadmap 12c copies an org template's docs through here too, as TipTap `content`.
   *
   * @returns how many docs were created
   */
  async importDocs(
    subject: Subject,
    projectId: string,
    docs: readonly ImportedDocInput[],
  ): Promise<number> {
    if (subject.kind !== 'user' || docs.length === 0) return 0;
    const view = await this.view(subject, projectId);
    const documented = new Set(
      (
        await this.prisma.doc.findMany({
          where: { projectId, targetId: { in: docs.map((d) => d.targetId) } },
          select: { targetId: true },
        })
      ).map((row) => row.targetId),
    );
    const writable = docs.filter(
      (d) =>
        !documented.has(d.targetId) &&
        targetVisible(view.redacted, projectId, d.targetType, d.targetId) &&
        this.canEdit(view, d.targetType, d.targetId),
    );
    if (writable.length === 0) return 0;
    const { count } = await this.prisma.doc.createMany({
      data: writable.map((d) => {
        const content = parseContent('text' in d ? textToRichText(d.text) : d.content);
        const structured = 'text' in d ? undefined : parseStructured(d.targetType, d.structured);
        return {
          id: randomUUID(),
          projectId,
          targetType: d.targetType,
          targetId: d.targetId,
          content: content as Prisma.InputJsonValue,
          plainText: docPlainText(content),
          ...(structured == null ? {} : { structured }),
          updatedById: subject.userId,
          version: 1,
        };
      }),
      // A doc written since the read above wins too: the `(target_type, target_id)` index.
      skipDuplicates: true,
    });
    if (count > 0) await this.broadcast(projectId, subject.userId);
    return count;
  }

  // -------------------------------------------------------------------------------------

  private async view(
    subject: Subject,
    projectId: string,
    known?: ProjectPermissionMap,
  ): Promise<CallerView> {
    const map = known ?? (await this.resolver.resolveProject(subject, projectId));
    // Invisible is 404 (§7.9): a project the caller cannot open does not exist for them.
    if (!this.resolver.canOpenProject(map)) throw notFound('project', projectId);
    const skel = await this.resolver.skeleton(projectId);
    const redacted = this.filter.redactWith(
      await this.loader.load(projectId),
      subject,
      projectId,
      map,
      skel,
    );
    return { subject, projectId, map, skel, redacted };
  }

  /** Unknown type, missing and invisible are the same 404. */
  private visibleTarget(view: CallerView, targetType: string, targetId: string): DocTargetType {
    const type = DOC_TARGET_TYPES.find((t) => t === targetType);
    if (type === undefined || !targetVisible(view.redacted, view.projectId, type, targetId)) {
      throw notFound(targetType, targetId);
    }
    return type;
  }

  private canEdit(view: CallerView, targetType: DocTargetType, targetId: string): boolean {
    if (view.subject.kind !== 'user') return false;
    const ref = authorityRef(view.redacted, targetType, targetId);
    return this.resolver.atomsAt(view.map, view.skel, ref).has('docs:edit');
  }

  /**
   * Doc 04 §8.10 — a `SchemaOperationResult`-shaped frame. The gateway never reads a
   * frame's `changed` (it diffs each recipient's redacted view before/after), so the
   * refreshed `DocRef` reaches exactly the readers who can see the object. `seq` is read,
   * not bumped, as for geometry: a doc edit invalidates nobody's diagnostics, and a
   * repeated `seq` is not a gap. A project-level doc has no IR object, so it emits nothing
   * visible; docs mode refetches on focus.
   */
  private async broadcast(projectId: string, actorUserId: string): Promise<void> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId },
      select: { schemaRevision: true },
    });
    if (project === null) return;
    this.commits.results.next({
      batchId: randomUUID(),
      projectId,
      actorUserId,
      seq: Number(project.schemaRevision),
      changed: {},
      removed: [],
    });
  }
}

function parseContent(raw: unknown): Record<string, unknown> {
  const clean = sanitizeRichText(raw);
  const parsed = clean === null ? null : richTextSchema.safeParse(clean);
  if (parsed?.success !== true) throw new BadRequestException({ code: 'invalid_doc_content' });
  return parsed.data;
}

/** A comment's plain text as TipTap JSON: one paragraph per non-blank line. */
function textToRichText(text: string): unknown {
  return {
    type: 'doc',
    content: text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
  };
}

/** Undefined = leave as stored; null = clear. Facts exist for entities and fields only. */
function parseStructured(targetType: DocTargetType, raw: unknown): unknown {
  if (raw === undefined || raw === null) return raw;
  const parsed = structuredDocSchema.safeParse(raw);
  if (!parsed.success || parsed.data.targetType !== targetType) {
    throw new BadRequestException({ code: 'invalid_doc_structured' });
  }
  return parsed.data;
}

function toView(
  row: Doc | null,
  targetType: DocTargetType,
  targetId: string,
  canEdit: boolean,
): DocView {
  return {
    targetType,
    targetId,
    content: row?.content ?? EMPTY_DOC,
    structured: row?.structured ?? null,
    plainText: row?.plainText ?? '',
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    canEdit,
  };
}
