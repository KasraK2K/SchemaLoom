import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs';
import { SnapshotsModule } from '../snapshots';
import { StorageModule } from '../storage';
import { IntrospectController } from './introspect.controller';
import { IntrospectService } from './introspect.service';
import { SavedConnectionController } from './saved-connection.controller';
import { SavedConnectionService } from './saved-connection.service';

/** Phase 6. Prisma, access, engines, config and Redis are `@Global()`. */
@Module({
  imports: [SnapshotsModule, JobsModule, StorageModule],
  controllers: [IntrospectController, SavedConnectionController],
  providers: [IntrospectService, SavedConnectionService],
})
export class IntrospectModule {}
