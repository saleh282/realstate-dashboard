import {
  Controller,
  Get,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { SystemRole } from '../auth/roles.enum';
import { RolesGuard } from '../auth/roles.guard';
import { UsersService } from '../users/users.service';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { Capability } from '../authorization/capability';

@Roles(SystemRole.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard, CapabilityGuard)
@RequireCapabilities(Capability.ADMIN_DASHBOARD_READ)
@Controller('admin/dashboard')
export class AdminDashboardController {
  constructor(private readonly usersService: UsersService) {}

  @Get('metrics')
  getMetrics() {
    return this.usersService.getDashboardMetricsForAdmin();
  }
}
