'use strict';

const { ServiceUnavailableException } = require('../common/http/errors');
// Served outside the /api/v1 prefix (see app.setup.ts) for orchestrator probes.
// Responses deliberately carry no versions, hostnames or error details.
class HealthController {
  constructor(health) {
    this.health = health;
  }
  live() {
    return this.health.liveness();
  }
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

Object.assign(exports, { HealthController });
