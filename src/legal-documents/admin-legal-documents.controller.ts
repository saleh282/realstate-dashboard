import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { SystemRole } from '../auth/roles.enum';
import { RolesGuard } from '../auth/roles.guard';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { Capability } from '../authorization/capability';
import {
  CreateLegalDocumentDraftDto,
  ListLegalDocumentsQueryDto,
  UpdateLegalDocumentDraftDto,
} from './dto/legal-document.dto';
import { LegalDocumentsService } from './legal-documents.service';

@Roles(SystemRole.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard, CapabilityGuard)
@RequireCapabilities(Capability.ADMIN_CATALOG_MANAGE)
@Controller('admin/legal-documents')
export class AdminLegalDocumentsController {
  constructor(private readonly service: LegalDocumentsService) {}
  @Get() list(@Query() query: ListLegalDocumentsQueryDto) { return this.service.listAdmin(query.type); }
  @Get(':documentId') get(@Param('documentId') id: string) { return this.service.getAdmin(id); }
  @Post() create(@Body() dto: CreateLegalDocumentDraftDto, @Req() req: any) { return this.service.createDraft(dto, req.user.userId, req.ip); }
  @Patch(':documentId') update(@Param('documentId') id: string, @Body() dto: UpdateLegalDocumentDraftDto, @Req() req: any) { return this.service.updateDraft(id, dto, req.user.userId, req.ip); }
  @Post(':documentId/publish') publish(@Param('documentId') id: string, @Req() req: any) { return this.service.publish(id, req.user.userId, req.ip); }
}
