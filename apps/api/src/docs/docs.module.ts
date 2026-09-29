import { Module } from '@nestjs/common';
import { SchemaModule } from '../schema';
import { DocsController } from './docs.controller';
import { DocsService } from './docs.service';

/** Prisma and access are `@Global()`. `DocsService` is exported for the AI draft accept. */
@Module({
  imports: [SchemaModule],
  controllers: [DocsController],
  providers: [DocsService],
  exports: [DocsService],
})
export class DocsModule {}
