import type { Cardinality, Id, LinkEndpoint } from '@schemaloom/schema-model';
import { apiFetch } from '@/lib/api-client';

/**
 * The write behind an accepted drag: one op, one batch, one transaction (§8.2).
 *
 * It goes to `/schema/ops` and NOT to the geometry endpoint — the mirror of the rule in
 * `geometry.ts`. A link is schema, so it takes a version bump and a conflict check;
 * geometry is not, so it takes neither.
 *
 * Nothing server-owned is sent: no `version`, no `refs`, no `doc`. The op schemas omit
 * those keys by construction, so a payload that carried them would be a 422 rather than a
 * silently trusted field. The id IS client-minted — ids are opaque strings (C1) and
 * minting one here is what lets the optimistic edge and the server row be the same object.
 */
export interface NewLink {
  readonly kind: string;
  readonly from: LinkEndpoint;
  readonly to: LinkEndpoint;
  readonly cardinality: Cardinality;
}

export async function createLink(projectId: Id, link: NewLink): Promise<void> {
  await apiFetch<unknown>(`/projects/${projectId}/schema/ops`, {
    method: 'POST',
    body: {
      batchId: crypto.randomUUID(),
      projectId,
      ops: [
        {
          op: 'create',
          type: 'link',
          object: {
            id: crypto.randomUUID(),
            // Legal and deliberate: the engine names a foreign key on export, and a name
            // invented here would be a PostgreSQL identifier core has no business coining.
            name: '',
            engineProps: {},
            kind: link.kind,
            from: link.from,
            to: link.to,
            cardinality: link.cardinality,
          },
        },
      ],
    },
  });
}
