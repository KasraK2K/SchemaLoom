import { Module } from '@nestjs/common';
import { GeometryWriter } from './geometry.service';
import { SchemaController } from './schema.controller';
import { SchemaLoader } from './schema-loader.service';
import { SchemaCommits, SchemaWriter } from './schema-writer.service';

/**
 * Build-order steps 13-14. `PrismaModule` and `AccessModule` are both `@Global()`
 * (doc 01 §4), so `PrismaService`, `PermissionResolver` and `VisibilityFilter` resolve
 * from the root injector and are deliberately NOT imported here — importing them again
 * would create a second, unrelated set of providers and a second permission cache.
 *
 * `SchemaLoader` is exported because later steps read the IR rather than serve it: the
 * exporter, the snapshot writer, the diff and the AI context builder all start from a
 * `RawSchemaModel`, and all of them have to pass it through `VisibilityFilter` to get
 * anything out of it.
 */
@Module({
  controllers: [SchemaController],
  providers: [SchemaLoader, SchemaWriter, GeometryWriter, SchemaCommits],
  exports: [SchemaLoader, SchemaWriter, GeometryWriter, SchemaCommits],
})
export class SchemaModule {}
