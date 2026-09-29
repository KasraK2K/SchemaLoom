import type { CoreMessageId, EngineCapabilities, TermSubject } from '@schemaloom/engine-sdk/ui';

/**
 * §16.5 — ONE declaration drives every surface.
 *
 * The standing rule: every core feature some engine might lack is declared in exactly one
 * table, with one `available` predicate over `EngineCapabilities`. A predicate rather than a
 * single feature atom, because "any of these" is a real requirement — see `constraints`.
 */
export interface InspectorTab {
  readonly id: string;
  readonly messageId: CoreMessageId;
  readonly subject: TermSubject;
  readonly available?: (caps: EngineCapabilities) => boolean;
}

export const INSPECTOR_TABS: readonly InspectorTab[] = [
  { id: 'details', messageId: 'tab.details', subject: 'entity' },
  { id: 'docs', messageId: 'tab.docs', subject: 'entity' },
  {
    id: 'indexes',
    messageId: 'tab.indexes',
    subject: 'index',
    available: (c) => c.features.indexes,
  },
  {
    id: 'constraints',
    messageId: 'tab.constraints',
    subject: 'constraint',
    // Not `features.checkConstraints`: an engine with primary keys but no CHECK still needs
    // the tab.
    available: (c) => c.constraintKinds.length > 0,
  },
  {
    id: 'comments',
    messageId: 'tab.comments',
    subject: 'entity',
    available: (c) => c.features.comments,
  },
];

export const visibleTabs = (caps: EngineCapabilities): readonly InspectorTab[] =>
  INSPECTOR_TABS.filter((tab) => tab.available === undefined || tab.available(caps));
