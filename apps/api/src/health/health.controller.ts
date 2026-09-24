import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { HealthService, type ReadinessReport } from './health.service';

/**
 * Both routes are excluded from the `api` global prefix in `main.ts` — an
 * orchestrator's probe path must not move when the API's prefix does.
 *
 * SEAM: when the guard chain lands (build-order steps 10-11), both routes take
 * `@Public()`. Doc 01 §4.1's boot-time route sweep only walks `/api/**`, so these two
 * are outside it — which is exactly why the decorator must be added deliberately here
 * rather than being caught by the sweep.
 */
@ApiTags('health')
@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness: the process is up. No dependency is consulted — a dead Postgres must
   *  not get the container restarted in a loop. */
  @Get('healthz')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: this instance can serve traffic. 503 while a dependency is down. */
  @Get('readyz')
  async readiness(): Promise<ReadinessReport> {
    const report = await this.health.readiness();
    if (report.status !== 'ok') throw new ServiceUnavailableException(report);
    return report;
  }
}
