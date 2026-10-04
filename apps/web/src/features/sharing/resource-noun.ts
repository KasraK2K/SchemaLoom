import type { ResourceType } from '@schemaloom/contracts';
import type { Terminology } from '@/engines';
import type { ResourceNode } from './model';

/**
 * §16.2 — the sharing dialog names resources, and an *entity* is called a Table in
 * PostgreSQL and a Collection in MongoDB. Nothing here hard-codes either.
 *
 * Returned as a plain function rather than called through a hook inside every row, so the
 * row components stay hook-free and can be rendered in a test without an
 * `<EngineProvider>` — the same split `EntityBody` uses on the canvas.
 */
export type ResourceNoun = (type: ResourceType) => string;

export function resourceNounFor(terminology: Terminology): ResourceNoun {
  return (type) => {
    switch (type) {
      case 'area':
        return terminology.term('area').one;
      case 'entity':
        return terminology.term('entity').one;
      case 'project':
        return 'Project';
    }
  };
}

/** A grant's level as the Why list says it: a workspace grant (roadmap 19) by name. */
export function grantLevelLabel(
  noun: ResourceNoun,
  grant: {
    readonly resourceType: ResourceNode['type'] | 'workspace';
    readonly resourceId: string;
    readonly resourceName: string;
  },
): string {
  return grant.resourceType === 'workspace'
    ? `Workspace: ${grant.resourceName}`
    : resourceOptionLabel(noun, {
        type: grant.resourceType,
        id: grant.resourceId,
        name: grant.resourceName,
        parentId: null,
      });
}

/** "Project", "Area: Billing", "Table: orders" — the label a scope picker shows. */
export function resourceOptionLabel(noun: ResourceNoun, node: ResourceNode): string {
  return node.type === 'project' ? noun('project') : `${noun(node.type)}: ${node.name}`;
}
