import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { SystemRole } from '../auth/roles.enum';
import { RolesGuard } from '../auth/roles.guard';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { Capability } from '../authorization/capability';
import { OperationalStatusService } from '../operations/operational-status.service';

/** Operator diagnostics: read-only, staff only. Never part of the public readiness probe. */
@Roles(SystemRole.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard, CapabilityGuard)
@RequireCapabilities(Capability.ADMIN_DASHBOARD_READ)
@Controller('admin/operations')
export class AdminOperationsController {
  constructor(private readonly operations: OperationalStatusService) {}

  @Get('status')
  status() {
    return this.operations.status();
  }
}
