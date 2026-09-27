import { Body, Controller, Get, HttpCode, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { SystemRole } from '../auth/roles.enum';
import { RolesGuard } from '../auth/roles.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { Capability } from '../authorization/capability';
import { CapabilityGuard } from '../authorization/capability.guard';
import { AdminPropertyFormDefinitionsService } from './admin-property-form-definitions.service';
import {
  ArchiveFormDefinitionDto,
  CreateFormDefinitionDto,
  DiscardFormDraftDto,
  ExpectedFormVersionDto,
  PublishFormDraftDto,
  UpdateFormDraftDto,
} from './dto/admin-form-definition.dto';

/**
 * DPF-030..032 Admin form builder. Reading and preparing drafts is catalog
 * management; publishing, archiving and restoring change what every client
 * may write, so they need ADMIN_FORM_DEFINITION_PUBLISH (SUPER_ADMIN).
 */
@Roles(SystemRole.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard, CapabilityGuard)
@RequireCapabilities(Capability.ADMIN_CATALOG_MANAGE)
@Controller('admin/property-form-definitions')
export class AdminPropertyFormDefinitionsController {
  constructor(private readonly service: AdminPropertyFormDefinitionsService) {}

  @Get('options')
  options() { return this.service.builderOptions(); }

  @Get()
  list() { return this.service.listDefinitions(); }

  @Post()
  create(@Body() dto: CreateFormDefinitionDto, @Req() req: any) {
    return this.service.createDefinition(dto, actor(req));
  }

  @Get(':definitionId')
  get(@Param('definitionId') definitionId: string) { return this.service.getDefinition(definitionId); }

  @Get(':definitionId/versions/:versionId')
  getVersion(@Param('definitionId') definitionId: string, @Param('versionId') versionId: string) {
    return this.service.getVersion(definitionId, versionId);
  }

  @Post(':definitionId/draft')
  createDraft(@Param('definitionId') definitionId: string, @Body() dto: ExpectedFormVersionDto, @Req() req: any) {
    return this.service.createDraft(definitionId, dto, actor(req));
  }

  @Put(':definitionId/draft')
  updateDraft(@Param('definitionId') definitionId: string, @Body() dto: UpdateFormDraftDto, @Req() req: any) {
    return this.service.updateDraft(definitionId, dto, actor(req));
  }

  @Post(':definitionId/draft/discard')
  @HttpCode(200)
  discardDraft(@Param('definitionId') definitionId: string, @Body() dto: DiscardFormDraftDto, @Req() req: any) {
    return this.service.discardDraft(definitionId, dto, actor(req));
  }

  @Post(':definitionId/draft/validate')
  @HttpCode(200)
  validateDraft(@Param('definitionId') definitionId: string) { return this.service.validateDraft(definitionId); }

  @Get(':definitionId/draft/diff')
  diffDraft(@Param('definitionId') definitionId: string) { return this.service.diffDraft(definitionId); }

  @Post(':definitionId/publish')
  @HttpCode(200)
  @RequireCapabilities(Capability.ADMIN_FORM_DEFINITION_PUBLISH)
  publish(@Param('definitionId') definitionId: string, @Body() dto: PublishFormDraftDto, @Req() req: any) {
    return this.service.publish(definitionId, dto, actor(req));
  }

  @Post(':definitionId/archive')
  @HttpCode(200)
  @RequireCapabilities(Capability.ADMIN_FORM_DEFINITION_PUBLISH)
  archive(@Param('definitionId') definitionId: string, @Body() dto: ArchiveFormDefinitionDto, @Req() req: any) {
    return this.service.archive(definitionId, dto, actor(req));
  }

  @Post(':definitionId/restore')
  @HttpCode(200)
  @RequireCapabilities(Capability.ADMIN_FORM_DEFINITION_PUBLISH)
  restore(@Param('definitionId') definitionId: string, @Body() dto: ExpectedFormVersionDto, @Req() req: any) {
    return this.service.restore(definitionId, dto, actor(req));
  }
}

const actor = (req: any) => ({ userId: req.user.userId, ip: req.ip });
