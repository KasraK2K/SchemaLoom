import { Module } from '@nestjs/common';
import { AuthModule } from '../auth';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications';
import { AccessRequestsService } from './access-requests.service';
import { AccessWriter } from './access-write';
import { GrantsService } from './grants.service';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { ShareLinkRedeemController } from './share-link-redeem.controller';
import { ShareLinkRedeemService } from './share-link-redeem.service';
import { ShareLinksService } from './share-links.service';
import { SharingController } from './sharing.controller';

/**
 * Doc 05 §7.7 and §7.12-§7.14. `PrismaModule`, `AccessModule` and `RedisModule` are
 * global, so their providers resolve from the root injector (see `ProjectsModule`).
 */
@Module({
  // `TokensService` mints the `sl_session` a redeemed link hands out; `MailService` sends
  // email invites (R11).
  imports: [AuthModule, MailModule, NotificationsModule],
  controllers: [SharingController, ShareLinkRedeemController, InvitationsController],
  providers: [
    AccessWriter,
    GrantsService,
    ShareLinksService,
    AccessRequestsService,
    ShareLinkRedeemService,
    InvitationsService,
  ],
})
export class SharingModule {}
