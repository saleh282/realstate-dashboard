import {
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { SystemRole } from '../auth/roles.enum';
import { RolesGuard } from '../auth/roles.guard';
import { AuditLogService } from '../audit/audit-log.service';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { Capability } from '../authorization/capability';

@Roles(SystemRole.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard, CapabilityGuard)
@RequireCapabilities(Capability.ADMIN_AUDIT_READ)
@Controller('admin/audit-logs')
export class AdminAuditController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  list(@Query() query: ListAuditLogsQueryDto) {
    return this.auditLogService.listForAdmin({
      page: query.page,
      limit: query.limit,
      action: query.action,
      targetUserId: query.targetUserId,
      actorUserId: query.actorUserId,
    });
  }
}
