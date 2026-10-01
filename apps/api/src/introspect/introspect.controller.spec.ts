import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { IntrospectController } from './introspect.controller';
import type { IntrospectService } from './introspect.service';

const TOKEN_REQ = {
  auth: {
    kind: 'user',
    userId: 'u1',
    orgId: 'org1',
    token: { tokenId: 't1', projectId: 'p1', scopes: ['read', 'drift'] },
  },
} as unknown as Request;

describe('IntrospectController.drift with an API token (Phase 11 Q4)', () => {
  it('refuses typed-in connection details before connecting anywhere', () => {
    const service = { drift: vi.fn() };
    const controller = new IntrospectController(service as unknown as IntrospectService);
    expect(() =>
      controller.drift(TOKEN_REQ, 'p1', {
        connection: { host: 'evil.example' },
        allowDestructive: false,
        transactional: true,
      }),
    ).toThrow(BadRequestException);
    expect(service.drift).not.toHaveBeenCalled();
  });
});
