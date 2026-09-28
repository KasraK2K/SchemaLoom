import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SchemaModule } from '../schema';
import { RealtimeGateway } from './realtime.gateway';

/** Doc 01 §4 — Phase 4's Socket.IO gateway. `AccessModule`/`PrismaModule` are global. */
@Module({
  imports: [AuthModule, SchemaModule],
  providers: [RealtimeGateway],
})
export class RealtimeModule {}
