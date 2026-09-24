import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** Doc 01 §4: `@Global()`. Every domain module needs the client. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
