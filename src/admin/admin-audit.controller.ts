import {
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../auth/roles.enum';
import { RolesGuard } from '../auth/roles.guard';
import { AuditLogService } from '../audit/audit-log.service';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';

@Roles(UserRole.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard)
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
