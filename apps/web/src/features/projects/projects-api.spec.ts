import postgresFacet from '@schemaloom/engine-postgresql-ui/facet';
import { describe, expect, it } from 'vitest';
import { EngineOptionSchema } from './projects-api';

/** A field kind or member the SDK adds must not break the projects page after sign-in. */
describe('EngineOptionSchema', () => {
  it('accepts the real engine’s connection form and keeps what the form needs', () => {
    const parsed = EngineOptionSchema.parse({
      id: 'postgresql',
      displayName: 'PostgreSQL',
      capabilities: postgresFacet.capabilities,
    });
    expect(parsed.capabilities.connectionFields).toEqual(
      postgresFacet.capabilities.connectionFields,
    );
  });
});
