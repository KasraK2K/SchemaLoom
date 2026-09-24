import type { PermissionAtom } from '@schemaloom/contracts';

/**
 * Doc 05 §10.5 — the guard's whole audit surface.
 *
 * **Denials are not `audit_log` rows.** They are high-volume and attacker-controlled: a
 * scanner walking ids would let anyone write unbounded rows into an append-only table
 * nobody can prune. They go to pino at `warn`, one line per denial, with a fixed shape.
 *
 * Everything else §10.5 audits — grant/role/group/share-link writes, `isRestricted`
 * toggles, the R13 admin-override read — is written **by the service, inside the
 * transaction**, never from a guard or an interceptor, because an enhancer cannot join
 * the transaction and would happily log a change that rolled back.
 *
 * ponytail: no Redis burst counter yet. §10.5 wants one to alert on enumeration from a
 * single subject; the line below carries `subjectKey`, so the alert is a log query until
 * there is an alerting pipeline to fire into. Upgrade path: `INCR`+`EXPIRE` on
 * `denials:{subjectKey}` in `logDenial`, best-effort, never on the decision path.
 */

export type DenialOutcome =
  | 'route_not_classified'
  | 'no_subject'
  | 'no_org'
  | 'share_link_route'
  | 'share_link_project'
  | 'not_visible'
  | 'missing_atom'
  | 'org_role';

export interface DenialEvent {
  readonly requestId: string | null;
  readonly subjectKey: string | null;
  readonly projectId: string | null;
  /** `type:id` per ref, so the line greps the same way whatever the locator shape was. */
  readonly refs: readonly string[];
  readonly atom: PermissionAtom | null;
  readonly outcome: DenialOutcome;
}

export type DenialContext = Omit<DenialEvent, 'requestId'>;

/** One line, one shape. `permission_denied` is the grep token. */
export const denialLine = (event: DenialEvent): string =>
  `permission_denied ${JSON.stringify(event)}`;

export interface WarnLogger {
  warn(message: string): void;
}

export const logDenial = (logger: WarnLogger, event: DenialEvent): void => {
  logger.warn(denialLine(event));
};
