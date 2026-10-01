import { Module } from '@nestjs/common';
import { ApiTokensController } from './api-tokens.controller';
import { ApiTokensService } from './api-tokens.service';

/** Phase 11. Prisma and access are `@Global()`; token *authentication* lives in AuthModule. */
@Module({
  controllers: [ApiTokensController],
  providers: [ApiTokensService],
})
export class ApiTokensModule {}
