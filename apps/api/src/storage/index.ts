/** The storage module's public surface. */
export { StorageModule } from './storage.module';
export {
  PRESIGN_GET_TTL_SEC,
  PRESIGN_PUT_TTL_SEC,
  S3_FORCE_PATH_STYLE,
  S3_REGION,
  StorageService,
  createS3Client,
  type S3Credentials,
} from './storage.service';
export { S3_BUCKET, S3_CLIENT } from './storage.tokens';
