import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs';
import { NotificationsModule } from '../notifications';
import { SnapshotsModule } from '../snapshots';
import { StorageModule } from '../storage';
import { DriftCheckService } from './drift-check.service';
import { DriftSweepRuntime } from './drift-sweep.runtime';
import { IntrospectController } from './introspect.controller';
import { IntrospectService } from './introspect.service';
import { SavedConnectionController } from './saved-connection.controller';
import { SavedConnectionService } from './saved-connection.service';

/** Phase 6 (6a–6d). Prisma, access, engines, config and Redis are `@Global()`. */
@Module({
  imports: [SnapshotsModule, JobsModule, StorageModule, NotificationsModule],
  controllers: [IntrospectController, SavedConnectionController],
  providers: [IntrospectService, SavedConnectionService, DriftCheckService, DriftSweepRuntime],
})
export class IntrospectModule {}
