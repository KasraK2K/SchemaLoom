import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3_BUCKET, S3_CLIENT, S3_PRESIGN_CLIENT } from './storage.tokens';

/**
 * Doc 01 §11.1 deleted `S3_REGION` and `S3_FORCE_PATH_STYLE` from the environment table:
 * "If it is not in `.env.example`, no task may read it." Both are CONSTANTS here, next to
 * their only consumer.
 *
 * `us-east-1` because MinIO ignores the region but the SigV4 signer refuses to sign
 * without one, and path style because `http://localhost:9000/schemaloom/key` is the only
 * addressing a local MinIO answers — a virtual-hosted bucket needs DNS for
 * `schemaloom.localhost`, which nobody is going to configure to run the dev loop.
 */
export const S3_REGION = 'us-east-1';
export const S3_FORCE_PATH_STYLE = true;

export interface S3Credentials {
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * The one place an `S3Client` is configured, so the module and the specs cannot drift.
 *
 * `requestChecksumCalculation: 'WHEN_REQUIRED'` is NOT tuning. Since v3.729 the SDK bakes
 * a precomputed `x-amz-checksum-crc32` into every `PutObject` — including a PRESIGNED one,
 * where it is the checksum of an empty body, because there is no body at signing time. The
 * browser upload (doc 01 §4.3) then sends real bytes against a signature that promised a
 * CRC32 of nothing, and S3 rejects it. Leaving the default on would break the image export
 * in a way that only shows up against a real bucket.
 */
export function createS3Client(credentials: S3Credentials): S3Client {
  return new S3Client({
    endpoint: credentials.endpoint,
    region: S3_REGION,
    forcePathStyle: S3_FORCE_PATH_STYLE,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
  });
}

/**
 * Doc 01 §4.3 — the image export is CLIENT-rendered (`html-to-image` over the live React
 * Flow graph) and uploaded with this URL. It is minted per `export_jobs` row, for that one
 * object key and that one method, so the upload surface is not a general-purpose bucket
 * write; a SHORT expiry is the other half of that. `apps/api` has no headless browser and
 * must not grow one.
 */
export const PRESIGN_PUT_TTL_SEC = 300;

/** A download link handed to a browser that may take a moment to follow it. */
export const PRESIGN_GET_TTL_SEC = 900;

/**
 * The object store. One client, one bucket.
 *
 * `ensureBucket()` runs at boot so there is no provisioning sidecar in docker-compose:
 * the bucket a fresh clone needs is created by the process that needs it, and a second
 * boot is a `HeadBucket` that succeeds.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    @Inject(S3_BUCKET) private readonly bucket: string,
    @Optional() @Inject(S3_PRESIGN_CLIENT) presigner?: S3Client,
  ) {
    this.presigner = presigner ?? s3;
  }

  private readonly presigner: S3Client;

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  /**
   * Idempotent, and deliberately not "create and ignore the error": `HeadBucket` first
   * means the common case (every boot after the first) issues no write at all, and a
   * credential or endpoint problem surfaces as itself rather than as a confusing
   * `CreateBucket` failure.
   *
   * The `CreateBucket` race is still handled — two api processes booting together both
   * see a missing bucket — because `BucketAlreadyOwnedByYou` / `BucketAlreadyExists` mean
   * the postcondition holds, which is all a caller of `ensureBucket` asked for.
   */
  async ensureBucket(): Promise<void> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch {
      this.logger.log(`bucket ${this.bucket} not found, creating it`);
    }

    try {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!alreadyExists(error)) throw error;
    }
  }

  /** Server-rendered export artifacts (DDL, IR JSON, Markdown) land here. */
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /**
   * The client-render upload (§4.3). The signature covers the bucket, the key, the method
   * and the deadline — so the URL writes ONE object and expires. Without `contentLength`,
   * SigV4 query presigning signs only `host`, so `contentType` is a hint the URL cannot
   * enforce; with it, both headers are signed. Either way the object's type and size are
   * checked where it is consumed rather than assumed from the upload.
   */
  presignPut(
    key: string,
    contentType: string,
    expiresIn: number = PRESIGN_PUT_TTL_SEC,
    contentLength?: number,
  ): Promise<string> {
    return getSignedUrl(
      this.presigner,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: contentLength,
      }),
      // With a declared length, `content-type` and `content-length` become SIGNED headers,
      // so the store itself refuses an upload of another type or size. `head` still
      // checks the object afterwards (`ExportsService.complete`).
      contentLength === undefined
        ? { expiresIn }
        : { expiresIn, signableHeaders: new Set(['content-type', 'content-length']) },
    );
  }

  /** Size and type of an uploaded object, or null when there is none. */
  async head(key: string): Promise<{ size: number; contentType: string | null } | null> {
    try {
      const out = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: out.ContentLength ?? 0, contentType: out.ContentType ?? null };
    } catch (error) {
      if (error instanceof Error && (error.name === 'NotFound' || error.name === 'NoSuchKey')) {
        return null;
      }
      throw error;
    }
  }

  /** A queued SQL import's source (doc 00 Q22), read back by the import job. */
  async get(key: string): Promise<Buffer> {
    const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from((await out.Body?.transformToByteArray()) ?? []);
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** The download link for a finished `export_jobs` row. */
  presignGet(
    key: string,
    expiresIn: number = PRESIGN_GET_TTL_SEC,
    downloadName?: string,
  ): Promise<string> {
    return getSignedUrl(
      this.presigner,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        // `attachment`: the browser saves the file (a cross-origin `<a download>` is ignored)
        // and never renders an uploaded SVG in the bucket's origin.
        ResponseContentDisposition:
          downloadName === undefined ? undefined : `attachment; filename="${downloadName}"`,
      }),
      { expiresIn },
    );
  }
}

/** S3 reports a lost `CreateBucket` race under two names depending on the region. MinIO
 *  uses the first; both mean the bucket is there and it is ours. */
function alreadyExists(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists';
}
