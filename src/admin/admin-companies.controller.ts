import {
  Body,
  Controller,
  Headers,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'crypto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { SystemRole } from '../auth/roles.enum';
import { RolesGuard } from '../auth/roles.guard';
import { CompanyAccountsService } from './company-accounts.service';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { Capability } from '../authorization/capability';

@Roles(SystemRole.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard, CapabilityGuard)
@RequireCapabilities(Capability.COMPANY_CREATE)
@Controller('admin/companies')
export class AdminCompaniesController {
  constructor(private readonly companies: CompanyAccountsService) {}

  @Post()
  create(
    @Body() payload: Record<string, unknown>,
    @Req() request: any,
    @Headers('x-request-id') suppliedRequestId: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const requestId =
      typeof suppliedRequestId === 'string' && suppliedRequestId.length <= 100
        ? suppliedRequestId
        : randomUUID();
    response.setHeader('X-Request-Id', requestId);
    return this.companies.create(payload, {
      actorUserId: request.user.userId,
      requestId,
      ip: request.ip,
    });
  }
}
