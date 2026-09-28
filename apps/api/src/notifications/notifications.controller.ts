import { Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { NotificationPrefs } from '@schemaloom/contracts';
import type { Request } from 'express';
import { Authenticated } from '../access';
import { getPrincipal } from '../auth';
import { ListNotificationsQueryDto, NotificationPrefsPatchDto } from './notifications.dto';
import { NotificationsService, type NotificationView } from './notifications.service';

/**
 * Phase 4 DESIGN §4. Every route is the caller's own inbox, so `@Authenticated()` and a
 * `userId` filter; none is in `SHARE_LINK_ROUTES`. The prefs live beside `GET /auth/me`,
 * which is where the account surface already is.
 */
@ApiTags('notifications')
@Controller()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @ApiOperation({ summary: 'The caller’s notifications, newest first, with the unread count' })
  @Authenticated()
  @Get('notifications')
  list(
    @Req() req: Request,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<{ notifications: NotificationView[]; unreadCount: number; nextCursor: string | null }> {
    return this.notifications.list(userIdOf(req), query.cursor);
  }

  @ApiOperation({ summary: 'Mark every notification read' })
  @Authenticated()
  @HttpCode(204)
  @Post('notifications/read-all')
  readAll(@Req() req: Request): Promise<void> {
    return this.notifications.markAllRead(userIdOf(req));
  }

  @ApiOperation({ summary: 'Mark one notification read' })
  @Authenticated()
  @HttpCode(204)
  @Post('notifications/:id/read')
  read(@Req() req: Request, @Param('id') id: string): Promise<void> {
    return this.notifications.markRead(userIdOf(req), id);
  }

  @ApiOperation({ summary: 'Which notification emails the caller gets' })
  @Authenticated()
  @Get('auth/me/notification-prefs')
  prefs(@Req() req: Request): Promise<NotificationPrefs> {
    return this.notifications.prefs(userIdOf(req));
  }

  @ApiOperation({ summary: 'Turn notification emails on or off, per type' })
  @Authenticated()
  @Patch('auth/me/notification-prefs')
  updatePrefs(@Req() req: Request, @Body() body: NotificationPrefsPatchDto): Promise<NotificationPrefs> {
    return this.notifications.updatePrefs(userIdOf(req), body);
  }
}

/** A share-link principal is already 404'd by the guard; this keeps a moved guard closed. */
function userIdOf(req: Request): string {
  const principal = getPrincipal(req);
  if (principal?.kind !== 'user') throw new NotFoundException({ code: 'not_found' });
  return principal.userId;
}
