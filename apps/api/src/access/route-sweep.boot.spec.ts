import { Controller, Get, Post, type Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { Public } from '../auth/public.decorator';
import { Authenticated, RequireProjectAccess, RequireScimToken } from './route-markers';
import { RouteSweep } from './route-sweep';

/**
 * Doc 01 §4.1 — the sweep against a REAL Nest route table, not a hand-written one. This
 * is what proves the boot assertion actually bites: the global prefix is applied, its
 * `exclude` list is honoured, and marker metadata is read off the handler Nest bound.
 *
 * A throw from `onApplicationBootstrap` aborts `app.init()`, which is what "the process
 * refuses to start" means in practice.
 */

@Controller('projects')
class ProjectsController {
  @RequireProjectAccess('projectId')
  @Get(':projectId/ir')
  ir(): string {
    return 'ir';
  }
}

@Controller('auth')
class AuthLikeController {
  @Public()
  @Post('login')
  login(): string {
    return 'login';
  }

  @Authenticated()
  @Get('me')
  me(): string {
    return 'me';
  }
}

@Controller()
class ProbesController {
  @Public()
  @Get('healthz')
  live(): string {
    return 'ok';
  }

  @Public()
  @Get('readyz')
  ready(): string {
    return 'ok';
  }
}

@Controller('comments')
class UnmarkedController {
  @Get()
  list(): string {
    return 'list';
  }
}

@Controller('snapshots')
class DoubleMarkedController {
  @RequireProjectAccess('projectId')
  @Authenticated()
  @Get()
  list(): string {
    return 'list';
  }
}

async function boot(controllers: readonly Type<unknown>[]): Promise<void> {
  const moduleRef = await Test.createTestingModule({
    imports: [DiscoveryModule],
    controllers: [...controllers],
    providers: [RouteSweep],
  }).compile();
  const app = moduleRef.createNestApplication();
  // Exactly what main.ts does: the probes stay off the prefix.
  app.setGlobalPrefix('api', { exclude: ['healthz', 'readyz'] });
  try {
    await app.init();
  } finally {
    await app.close().catch(() => undefined);
  }
}

describe('RouteSweep at boot', () => {
  it('starts when every /api route is marked, probes and all', async () => {
    await expect(
      boot([ProjectsController, AuthLikeController, ProbesController]),
    ).resolves.toBeUndefined();
  });

  it('REFUSES TO START on a route with no marker', async () => {
    await expect(boot([ProjectsController, UnmarkedController])).rejects.toThrow(
      /UnmarkedController\.list[\s\S]*no route marker/,
    );
  });

  it('REFUSES TO START on a route with two markers', async () => {
    await expect(boot([DoubleMarkedController])).rejects.toThrow(
      /DoubleMarkedController\.list[\s\S]*2 route markers/,
    );
  });

  it('starts with a @RequireScimToken() controller under /scim/v2 (roadmap 14b)', async () => {
    @Controller('scim/v2')
    class ScimLike {
      @RequireScimToken()
      @Get('Users')
      users(): string {
        return 'users';
      }
    }
    await expect(boot([ScimLike])).resolves.toBeUndefined();
  });

  it('does not trip on /healthz and /readyz even when they are unmarked', async () => {
    @Controller()
    class BareProbes {
      @Get('healthz')
      live(): string {
        return 'ok';
      }

      @Get('readyz')
      ready(): string {
        return 'ok';
      }
    }
    await expect(boot([BareProbes])).resolves.toBeUndefined();
  });
});
