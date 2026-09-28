import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

/** Prisma and access are `@Global()`. Exported for the realtime gateway. */
@Module({
  imports: [NotificationsModule],
  controllers: [CommentsController],
  providers: [CommentsService],
  exports: [CommentsService],
})
export class CommentsModule {}
