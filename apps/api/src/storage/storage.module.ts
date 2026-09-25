import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { S3Client } from '@aws-sdk/client-s3';
import type { AppEnv } from '../config/env';
import { StorageService, createS3Client } from './storage.service';
import { S3_BUCKET, S3_CLIENT } from './storage.tokens';

const clientProvider: Provider = {
  provide: S3_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<AppEnv, true>): S3Client =>
    // Region and path style are §11.1-deleted rows, so they are constants inside
    // `createS3Client` rather than three more environment variables.
    createS3Client({
      endpoint: config.get('S3_ENDPOINT', { infer: true }),
      accessKeyId: config.get('S3_ACCESS_KEY_ID', { infer: true }),
      secretAccessKey: config.get('S3_SECRET_ACCESS_KEY', { infer: true }),
    }),
};

const bucketProvider: Provider = {
  provide: S3_BUCKET,
  inject: [ConfigService],
  useFactory: (config: ConfigService<AppEnv, true>): string =>
    config.get('S3_BUCKET', { infer: true }),
};

/**
 * Doc 01 §4.3 — object storage. `@Global()` is deliberately NOT used: exports live in
 * `JobsModule` and the export controller, and a module every other module can reach into
 * is how a bucket write ends up on a request path.
 */
@Module({
  providers: [clientProvider, bucketProvider, StorageService],
  exports: [StorageService],
})
export class StorageModule {}
