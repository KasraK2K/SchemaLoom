import { createZodDto } from 'nestjs-zod';
import { GeometryBatchSchema, SchemaOperationBatchSchema } from './ops';

/**
 * The trust boundary. `ZodValidationPipe` is global (`main.ts`), so naming these as the
 * `@Body()` type is what makes doc 04 §8.6 rule 9's "zod shape → 422" stage run before
 * any handler code — and what strips a client-supplied `version`, `refs`, `doc` or
 * `ordinal` rather than trusting a service to remember to ignore it.
 */
export class SchemaOpsDto extends createZodDto(SchemaOperationBatchSchema) {}

export class SchemaGeometryDto extends createZodDto(GeometryBatchSchema) {}
