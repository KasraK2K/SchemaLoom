import { expect } from '@playwright/test';
import type { Session } from './api';

/**
 * The structural subset of the redacted IR these specs assert on.
 *
 * Declared here rather than imported from `@schemaloom/schema-model`, because `e2e`
 * depends on `@schemaloom/contracts` and on neither app (doc 01 §12.2) and contracts does
 * not re-export the IR. It is a SUBSET on purpose: an e2e assertion that needs a field
 * this type does not name is usually an assertion that belongs in a unit test.
 */
export interface IrObject {
  readonly id: string;
  readonly name: string;
  /** C7 — echo it as `expectedVersion` on the next write. A stub always reports 0. */
  readonly version: number;
  readonly restricted?: true;
  readonly propsRedacted?: true;
  readonly engineProps: Record<string, unknown>;
}

export interface IrEntity extends IrObject {
  readonly areaId: string | null;
  readonly namespaceId: string;
}

export interface IrField extends IrObject {
  readonly entityId: string;
  readonly parentFieldId: string | null;
  readonly ordinal: number;
  readonly type: { readonly name: string };
  readonly isRestricted: boolean;
}

export interface Ir {
  readonly projectId: string;
  readonly redacted: boolean;
  readonly objects: {
    readonly area: Record<string, IrObject>;
    readonly namespace: Record<string, IrObject>;
    readonly entity: Record<string, IrEntity>;
    readonly field: Record<string, IrField>;
    readonly link: Record<string, IrObject>;
    readonly index: Record<string, IrObject>;
    readonly constraint: Record<string, IrObject>;
  };
}

/** `GET /api/projects/:id/ir` — the only path schema data takes out of the server. */
export async function fetchIr(session: Session, projectId: string): Promise<Ir> {
  const response = await session.api.get(`/api/projects/${projectId}/ir`);
  expect(response.status(), await response.text()).toBe(200);
  const ir = (await response.json()) as Ir;
  expect(ir.redacted, 'the API must never serve an unredacted model').toBe(true);
  return ir;
}

export const entityNames = (ir: Ir): string[] =>
  Object.values(ir.objects.entity)
    .map((e) => e.name)
    .filter((n) => n !== '')
    .sort();

export const fieldsOf = (ir: Ir, entityId: string): IrField[] =>
  Object.values(ir.objects.field)
    .filter((f) => f.entityId === entityId)
    .sort((a, b) => a.ordinal - b.ordinal);
