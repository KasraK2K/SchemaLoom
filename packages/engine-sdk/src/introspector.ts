/**
 * Phase 6 §1 — reading a live database. **Introspection produces import source, not IR**: the
 * result is text in one of the engine's own `importFormats`, and core runs it through the
 * existing import pipeline (preview, confirmed renames, additive merge, batching). So there is
 * no second import path, and core learns nothing engine-specific.
 *
 * The form that collects `connection` is `capabilities.connectionFields`, which is data the
 * browser can read; this is the server half.
 */

export type ConnectionValues = Readonly<Record<string, string | number | readonly string[]>>;

/** The part of `AbortSignal` an introspector uses. Structural, because this package builds
 *  with neither DOM nor Node types. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface IntrospectRequest {
  /** keyed by `ConnectionField.id`; secrets included. Never persist or log it. */
  readonly connection: ConnectionValues;
  /** The host's address, already resolved and checked by core's SSRF guard (§3.2). The engine
   *  MUST connect to this address, not re-resolve the host, or DNS rebinding bypasses the
   *  guard. The host name stays in `connection` for TLS verification. */
  readonly resolvedAddress: string;
  readonly signal: AbortSignalLike;
  /** output cap; over it the engine throws `IntrospectError('too_large')` */
  readonly maxBytes: number;
}

export interface IntrospectResult {
  /** text in `format` */
  readonly source: string;
  /** an `importFormats` id */
  readonly format: string;
  /** shown in the preview and stored in the audit row */
  readonly serverVersion: string;
}

export interface Introspector {
  introspect(req: IntrospectRequest): Promise<IntrospectResult>;
}

export type IntrospectErrorCode =
  /** the tool it needs (`pg_dump`) is not installed on this server */
  | 'not_available'
  | 'unreachable'
  | 'auth_failed'
  | 'tls_failed'
  | 'server_too_new'
  | 'too_large'
  | 'timeout'
  | 'failed';

/**
 * The only error an introspector throws on purpose. `message` is shown to the user, so it must
 * never contain the password or the raw connection string.
 */
export class IntrospectError extends Error {
  constructor(
    readonly code: IntrospectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IntrospectError';
  }
}
