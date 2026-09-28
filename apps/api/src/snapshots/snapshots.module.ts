import { Module } from '@nestjs/common';
import { SchemaModule } from '../schema';
import { ImportController, SnapshotsController } from './snapshots.controller';
import { SnapshotsService } from './snapshots.service';

/**
 * Build-order step 19. `SchemaModule` is imported for `SchemaWriter` — restore goes
 * through the step-14 write path and there is no second mutation path.
 *
 * `PrismaModule`, `AccessModule` and `EnginesModule` are all `@Global()` (doc 01 §4), so
 * `PrismaService`, `VisibilityFilter` and `EngineGate` resolve from the root injector and
 * are deliberately NOT imported here: importing them again would create a second,
 * unrelated set of providers and a second permission cache.
 */
@Module({
  imports: [SchemaModule],
  controllers: [SnapshotsController, ImportController],
  providers: [SnapshotsService],
  exports: [SnapshotsService],
})
export class SnapshotsModule {}
