import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CommentsModule } from '../comments';
import { NotificationsModule } from '../notifications';
import { SchemaModule } from '../schema';
import { RealtimeBus } from './realtime-bus';
import { RealtimeGateway } from './realtime.gateway';

/** Doc 01 §4 — Phase 4's Socket.IO gateway. `AccessModule`/`PrismaModule` are global. */
@Module({
  imports: [AuthModule, SchemaModule, CommentsModule, NotificationsModule],
  providers: [RealtimeGateway, RealtimeBus],
})
export class RealtimeModule {}
