/**
 * Injection tokens for object storage.
 *
 * In their own file, not in `storage.module.ts`: the module imports the service and the
 * service injects the tokens, so declaring them in the module file makes that a require
 * cycle — which under CommonJS resolves to `undefined` at decoration time and fails DI
 * with an unhelpful "Nest can't resolve dependencies". Same reasoning as
 * `engines/engines.tokens.ts`.
 */

/** The one `S3Client`. MinIO locally, any S3-compatible endpoint in production. */
export const S3_CLIENT = Symbol('S3_CLIENT');

/** `S3_BUCKET` from the environment, resolved once so `StorageService` is constructible
 *  in a test without a `ConfigService`. */
export const S3_BUCKET = Symbol('S3_BUCKET');

/** Signs the URLs a BROWSER follows, against `S3_PUBLIC_URL`. SigV4 signs the host, so a URL
 *  minted with the internal endpoint cannot be rewritten afterwards. Same client when the two
 *  endpoints are equal (local dev). */
export const S3_PRESIGN_CLIENT = Symbol('S3_PRESIGN_CLIENT');
