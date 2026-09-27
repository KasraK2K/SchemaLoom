import { Module } from '@nestjs/common';
import { AccessRequestsService } from './access-requests.service';
import { AccessWriter } from './access-write';
import { GrantsService } from './grants.service';
import { ShareLinksService } from './share-links.service';
import { SharingController } from './sharing.controller';

/**
 * Doc 05 §7.7 and §7.12-§7.14. `PrismaModule`, `AccessModule` and `RedisModule` are
 * global, so their providers resolve from the root injector (see `ProjectsModule`).
 */
@Module({
  controllers: [SharingController],
  providers: [AccessWriter, GrantsService, ShareLinksService, AccessRequestsService],
})
export class SharingModule {}
