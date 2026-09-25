import type { Diagnostic, EngineStaticFacet } from '@schemaloom/engine-sdk/ui';
import type { Id } from '@schemaloom/schema-model';
import type { ComponentType, ReactNode } from 'react';
import { FALLBACK_ENGINE_UI, type EngineNodeProps, type EngineUiPlugin } from '@/engines';
import { FieldHandle, NoFieldHandle } from './field-handle';
import type { EntityNodeData } from './graph';
import { RestrictedNode } from './restricted-node';

/**
 * Which component draws a card, and with what.
 *
 * Hook-free on purpose — `EntityNode` is the hook wrapper. Everything that decides what a
 * viewer sees lives in a plain function, so the redaction rule can be asserted by a test
 * that renders it with a real engine plugin and no React Flow context, no store and no
 * provider tree.
 *
 * Core NEVER hands a restricted entity to an engine renderer. The engine's card draws
 * `entity.name`, and the server blanked that to `''`; routing a stub through it would
 * produce a nameless version of a normal card — a box that looks broken rather than one
 * that says "you may not see this". The branch is here, above the registry, for the same
 * reason the stub component takes no entity at all.
 */
export interface EntityBodyProps {
  readonly data: EntityNodeData;
  readonly facet: EngineStaticFacet;
  readonly ui: EngineUiPlugin;
  readonly selected: boolean;
  readonly collapsed: boolean;
  readonly highlightedFieldIds: ReadonlySet<Id>;
  readonly onFieldSelect: (fieldId: Id) => void;
  readonly onToggleCollapse: () => void;
}

/** Diagnostics reach the canvas with the validator (build-order step 26); until then the
 *  contract's array is genuinely empty rather than faked. */
const NO_DIAGNOSTICS: readonly Diagnostic[] = [];

export function EntityBody({
  data,
  facet,
  ui,
  selected,
  collapsed,
  highlightedFieldIds,
  onFieldSelect,
  onToggleCollapse,
}: EntityBodyProps): ReactNode {
  const { entity } = data;
  if (entity.restricted === true) return <RestrictedNode selected={selected} />;

  const Renderer: ComponentType<EngineNodeProps> | undefined =
    ui.nodeRenderers[entity.kind] ?? ui.defaultNodeRenderer ?? FALLBACK_ENGINE_UI.defaultNodeRenderer;
  // A plugin with neither a renderer for this kind nor a default is a broken plugin, and
  // the shipped fallback always has one. Nothing to invent here.
  if (Renderer === undefined) return null;

  return (
    <Renderer
      entity={entity}
      fields={data.fields}
      badges={data.badges}
      resolvedTypes={data.resolvedTypes}
      engine={facet}
      selected={selected}
      collapsed={collapsed}
      highlightedFieldIds={highlightedFieldIds}
      areaColor={data.areaColor}
      diagnostics={NO_DIAGNOSTICS}
      FieldHandle={handleFor(facet, entity.kind)}
      onFieldSelect={onFieldSelect}
      onToggleCollapse={onToggleCollapse}
    />
  );
}

/**
 * §16.1: "When `features.links` is false core supplies a component that renders `null`, so
 * hiding connection handles needs no branch here." The per-kind half is the same rule one
 * level down — a PostgreSQL view has `canBeLinkEndpoint: false`, and a handle on a row
 * that can never be an endpoint is an affordance that always ends in a rejected drag.
 */
function handleFor(facet: EngineStaticFacet, entityKind: string): ComponentType<{
  readonly fieldId: Id;
  readonly side: 'source' | 'target';
}> {
  if (!facet.capabilities.features.links) return NoFieldHandle;
  const kind = facet.capabilities.entityKinds.find((candidate) => candidate.id === entityKind);
  return kind?.canBeLinkEndpoint === false ? NoFieldHandle : FieldHandle;
}
