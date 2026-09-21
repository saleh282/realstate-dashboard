import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { HealthService } from './health.service';

// Served outside the /api/v1 prefix (see app.setup.ts) for orchestrator probes.
// Responses deliberately carry no versions, hostnames or error details.
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  live() {
    return this.health.liveness();
  }

  @Get('ready')
  async ready() {
    const result = await this.health.readiness();
    if (!result.ready) {
      throw new ServiceUnavailableException({
        message: 'الخدمة غير جاهزة',
        code: 'NOT_READY',
        quiet: true,
        details: result.checks,
      });
    }
    return { status: 'ready', checks: result.checks };
  }
}
