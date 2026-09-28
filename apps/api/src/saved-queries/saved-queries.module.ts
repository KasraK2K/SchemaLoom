import { Module } from '@nestjs/common';
import { SchemaModule } from '../schema';
import { SavedQueriesController } from './saved-queries.controller';
import { SavedQueriesService } from './saved-queries.service';

/** Prisma, access and engines are `@Global()`; only the loader needs an import. */
@Module({
  imports: [SchemaModule],
  controllers: [SavedQueriesController],
  providers: [SavedQueriesService],
})
export class SavedQueriesModule {}
