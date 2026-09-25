import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3_BUCKET, S3_CLIENT } from './storage.tokens';

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
  ) {}

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
   * and the deadline — so the URL writes ONE object and expires. `contentType` is the
   * value the uploader is expected to send; SigV4 query presigning signs only `host`, so
   * it is not a constraint the URL can enforce, and the object's type is checked where it
   * is consumed rather than assumed from the upload.
   */
  presignPut(
    key: string,
    contentType: string,
    expiresIn: number = PRESIGN_PUT_TTL_SEC,
  ): Promise<string> {
    return getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn },
    );
  }

  /** The download link for a finished `export_jobs` row. */
  presignGet(key: string, expiresIn: number = PRESIGN_GET_TTL_SEC): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn,
    });
  }
}

/** S3 reports a lost `CreateBucket` race under two names depending on the region. MinIO
 *  uses the first; both mean the bucket is there and it is ours. */
function alreadyExists(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists';
}
