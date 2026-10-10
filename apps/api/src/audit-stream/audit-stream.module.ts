import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs';
import { NotificationsModule } from '../notifications';
import { AuditStreamController } from './audit-stream.controller';
import { AuditStreamRuntime } from './audit-stream.runtime';
import { AuditStreamService } from './audit-stream.service';

/** Roadmap 14d — streaming the audit log to a SIEM. `PrismaModule` is global. */
@Module({
  imports: [JobsModule, NotificationsModule],
  controllers: [AuditStreamController],
  providers: [AuditStreamService, AuditStreamRuntime],
})
export class AuditStreamModule {}
