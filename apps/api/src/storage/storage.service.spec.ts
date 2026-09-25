import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { PRESIGN_PUT_TTL_SEC, StorageService, createS3Client } from './storage.service';

/**
 * No MinIO, no network. Two halves, each faked at the seam that matters:
 *
 *  - `ensureBucket` is about WHICH commands are sent, so it runs against a `send` spy.
 *  - presigning is pure SigV4 over the client's static credentials, so it runs against a
 *    REAL `S3Client`. Mocking the signer would leave the one thing worth asserting —
 *    that the URL carries an expiry and names exactly one key — untested.
 */

const BUCKET = 'schemaloom';

type SendResult = Promise<unknown>;

interface FakeS3 {
  readonly service: StorageService;
  readonly send: ReturnType<typeof vi.fn<(command: unknown) => SendResult>>;
  readonly sent: () => string[];
}

function fakeS3(send: (command: unknown) => SendResult): FakeS3 {
  const spy = vi.fn(send);
  const client = { send: spy } as unknown as S3Client;
  return {
    service: new StorageService(client, BUCKET),
    send: spy,
    sent: () => spy.mock.calls.map(([command]) => (command as object).constructor.name),
  };
}

/** The REAL client factory — constructing one opens no socket, and presigning is pure
 *  SigV4, so this needs no MinIO. Using the production factory is the point: the checksum
 *  defaults it disables are visible in the URL below. */
const realClient = (): S3Client =>
  createS3Client({
    endpoint: 'http://localhost:9000',
    accessKeyId: 'schemaloom',
    secretAccessKey: 'schemaloom-dev-secret',
  });

describe('ensureBucket', () => {
  it('creates the bucket when HeadBucket says it is missing', async () => {
    const fake = fakeS3((command) =>
      command instanceof HeadBucketCommand
        ? Promise.reject(new Error('NotFound'))
        : Promise.resolve({}),
    );

    await fake.service.ensureBucket();

    expect(fake.sent()).toEqual(['HeadBucketCommand', 'CreateBucketCommand']);
  });

  it('is idempotent — a second run against an existing bucket writes nothing', async () => {
    let exists = false;
    const fake = fakeS3((command) => {
      if (command instanceof HeadBucketCommand) {
        return exists ? Promise.resolve({}) : Promise.reject(new Error('NotFound'));
      }
      exists = true;
      return Promise.resolve({});
    });

    await fake.service.ensureBucket();
    await fake.service.ensureBucket();
    await fake.service.ensureBucket();

    expect(fake.sent()).toEqual([
      'HeadBucketCommand',
      'CreateBucketCommand',
      'HeadBucketCommand',
      'HeadBucketCommand',
    ]);
  });

  it('swallows a lost CreateBucket race, because the postcondition still holds', async () => {
    const conflict = new Error('bucket exists');
    conflict.name = 'BucketAlreadyOwnedByYou';
    const fake = fakeS3((command) =>
      Promise.reject(command instanceof CreateBucketCommand ? conflict : new Error('NotFound')),
    );

    await expect(fake.service.ensureBucket()).resolves.toBeUndefined();
  });

  it('rethrows a real CreateBucket failure rather than booting without a bucket', async () => {
    const denied = new Error('nope');
    denied.name = 'AccessDenied';
    const fake = fakeS3((command) =>
      Promise.reject(command instanceof CreateBucketCommand ? denied : new Error('NotFound')),
    );

    await expect(fake.service.ensureBucket()).rejects.toThrow('nope');
  });

  it('runs at boot, so there is no provisioning sidecar', async () => {
    const fake = fakeS3(() => Promise.resolve({}));
    await fake.service.onModuleInit();
    expect(fake.sent()).toEqual(['HeadBucketCommand']);
  });
});

describe('put', () => {
  it('writes the body under the bucket with its content type', async () => {
    const fake = fakeS3(() => Promise.resolve({}));
    await fake.service.put('exports/prj/job.sql', Buffer.from('CREATE TABLE t ();'), 'text/plain');

    const [command] = fake.send.mock.calls[0] ?? [];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect((command as PutObjectCommand).input).toMatchObject({
      Bucket: BUCKET,
      Key: 'exports/prj/job.sql',
      ContentType: 'text/plain',
    });
  });
});

describe('presigned URLs', () => {
  const service = new StorageService(realClient(), BUCKET);
  const key = 'exports/prj_shop/exj_1.png';

  it('mints a PUT for one key with the default short expiry', async () => {
    const url = new URL(await service.presignPut(key, 'image/png'));

    expect(url.pathname).toBe(`/${BUCKET}/${key}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(PRESIGN_PUT_TTL_SEC));
    expect(url.searchParams.get('x-id')).toBe('PutObject');
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });

  it('carries no precomputed checksum, or the browser upload would be rejected', async () => {
    const url = new URL(await service.presignPut(key, 'image/png'));

    // The SDK's default bakes a CRC32 of the EMPTY body into the signature, because there
    // is no body at signing time. `createS3Client` turns that off; if this fails, the
    // client-rendered image export fails against a real bucket and nowhere else.
    for (const [name] of url.searchParams) {
      expect(name).not.toMatch(/^x-amz-checksum-/);
      expect(name).not.toBe('x-amz-sdk-checksum-algorithm');
    }
  });

  it('honours an explicit expiry', async () => {
    const url = new URL(await service.presignPut(key, 'image/svg+xml', 60));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
  });

  it('mints a GET with an expiry too — no unsigned, never-expiring link', async () => {
    const url = new URL(await service.presignGet(key, 30));

    expect(url.pathname).toBe(`/${BUCKET}/${key}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('30');
    expect(url.searchParams.get('x-id')).toBe('GetObject');
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });

  it('signs one key — a URL for one export cannot read another', async () => {
    const mine = new URL(await service.presignGet(key, 30));
    const theirs = new URL(await service.presignGet('exports/prj_other/exj_2.png', 30));

    expect(mine.searchParams.get('X-Amz-Signature')).not.toBe(
      theirs.searchParams.get('X-Amz-Signature'),
    );
  });
});
