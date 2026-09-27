import { Module } from '@nestjs/common';
import { AuthModule } from '../auth';
import { AccessRequestsService } from './access-requests.service';
import { AccessWriter } from './access-write';
import { GrantsService } from './grants.service';
import { ShareLinkRedeemController } from './share-link-redeem.controller';
import { ShareLinkRedeemService } from './share-link-redeem.service';
import { ShareLinksService } from './share-links.service';
import { SharingController } from './sharing.controller';

/**
 * Doc 05 §7.7 and §7.12-§7.14. `PrismaModule`, `AccessModule` and `RedisModule` are
 * global, so their providers resolve from the root injector (see `ProjectsModule`).
 */
@Module({
  // `TokensService` mints the `sl_session` a redeemed link hands out.
  imports: [AuthModule],
  controllers: [SharingController, ShareLinkRedeemController],
  providers: [
    AccessWriter,
    GrantsService,
    ShareLinksService,
    AccessRequestsService,
    ShareLinkRedeemService,
  ],
})
export class SharingModule {}
