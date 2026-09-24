import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './env';

/**
 * Doc 01 §11: one file a human edits — `.env` at the repo ROOT. `envFilePath` is
 * relative to `process.cwd()`, which is `apps/api` for every script in this package.
 *
 * `validate` runs during module metadata evaluation, i.e. before the container is
 * built, which is the whole point of §11.4.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: ['../../.env'],
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
  ],
})
export class AppConfigModule {}
