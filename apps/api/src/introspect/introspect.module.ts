import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs';
import { SnapshotsModule } from '../snapshots';
import { StorageModule } from '../storage';
import { IntrospectController } from './introspect.controller';
import { IntrospectService } from './introspect.service';

/** Phase 6. Prisma, access, engines, config and Redis are `@Global()`. */
@Module({
  imports: [SnapshotsModule, JobsModule, StorageModule],
  controllers: [IntrospectController],
  providers: [IntrospectService],
})
export class IntrospectModule {}
