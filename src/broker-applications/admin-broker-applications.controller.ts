import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { SystemRole } from '../auth/roles.enum';
import { RolesGuard } from '../auth/roles.guard';
import { CloudinaryAssetService } from '../config/cloudinary-asset.service';
import { BrokerApplicationsService } from './broker-applications.service';
import { BrokerApplicationStatus } from './broker.types';
import { ArchiveBrokerRequirementDto } from './dto/archive-broker-requirement.dto';
import { ChangeBrokerStatusDto } from './dto/change-broker-status.dto';
import { CreateBrokerRequirementDto } from './dto/create-broker-requirement.dto';
import { ReviewBrokerApplicationDto } from './dto/review-broker-application.dto';
import { UpdateBrokerRequirementDto } from './dto/update-broker-requirement.dto';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { Capability } from '../authorization/capability';

@Roles(SystemRole.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard, CapabilityGuard)
@RequireCapabilities(Capability.ADMIN_BROKER_REVIEW)
@Controller('admin')
export class AdminBrokerApplicationsController {
  constructor(
    private readonly brokerApplications: BrokerApplicationsService,
    private readonly assets: CloudinaryAssetService,
  ) {}

  @Get('broker-requirements')
  listRequirements() {
    return this.brokerApplications.listRequirementsForAdmin();
  }

  @Post('broker-requirements')
  createRequirement(@Body() dto: CreateBrokerRequirementDto, @Req() request: any) {
    return this.brokerApplications.createRequirement(dto, this.actor(request));
  }

  @Patch('broker-requirements/:requirementId')
  updateRequirement(
    @Param('requirementId') requirementId: string,
    @Body() dto: UpdateBrokerRequirementDto,
    @Req() request: any,
  ) {
    return this.brokerApplications.updateRequirement(requirementId, dto, this.actor(request));
  }

  @Delete('broker-requirements/:requirementId')
  archiveRequirement(
    @Param('requirementId') requirementId: string,
    @Body() dto: ArchiveBrokerRequirementDto,
    @Req() request: any,
  ) {
    return this.brokerApplications.archiveRequirement(
      requirementId,
      dto.expectedVersion,
      dto.reason.trim(),
      this.actor(request),
    );
  }

  @Get('broker/applications')
  listApplications(
    @Query('status') status?: BrokerApplicationStatus,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.brokerApplications.listApplicationsForAdmin(status, page, limit);
  }

  @Get('broker/applications/:applicationId')
  getApplication(@Param('applicationId') applicationId: string) {
    return this.brokerApplications.getApplicationForAdmin(applicationId);
  }

  @Get('broker/applications/:applicationId/documents/:documentId')
  async getDocument(
    @Param('applicationId') applicationId: string,
    @Param('documentId') documentId: string,
    @Req() request: any,
    @Res({ passthrough: true }) response: Response,
  ) {
    const asset = await this.brokerApplications.getEvidenceForAdmin(
      request.user.userId,
      applicationId,
      documentId,
      request.ip,
    );
    const downloaded = await this.assets.downloadAuthenticatedAsset(asset);
    response.set({
      'Content-Type': downloaded.contentType,
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(downloaded.buffer);
  }

  @Post('broker/applications/:applicationId/review')
  review(
    @Param('applicationId') applicationId: string,
    @Body() dto: ReviewBrokerApplicationDto,
    @Req() request: any,
  ) {
    return this.brokerApplications.reviewApplication({
      applicationId,
      decision: dto.decision,
      reason: dto.reason,
      expectedVersion: dto.expectedVersion,
      actorUserId: request.user.userId,
      ip: request.ip,
    });
  }

  @Post('brokers/:userId/suspend')
  suspend(
    @Param('userId') userId: string,
    @Body() dto: ChangeBrokerStatusDto,
    @Req() request: any,
  ) {
    return this.brokerApplications.suspendBroker(
      userId,
      dto.expectedVersion,
      dto.reason.trim(),
      this.actor(request),
    );
  }

  @Post('brokers/:userId/restore')
  restore(
    @Param('userId') userId: string,
    @Body() dto: ChangeBrokerStatusDto,
    @Req() request: any,
  ) {
    return this.brokerApplications.restoreBroker(
      userId,
      dto.expectedVersion,
      dto.reason.trim(),
      this.actor(request),
    );
  }

  @Post('brokers/:userId/revoke')
  revoke(
    @Param('userId') userId: string,
    @Body() dto: ChangeBrokerStatusDto,
    @Req() request: any,
  ) {
    return this.brokerApplications.revokeBroker(
      userId,
      dto.expectedVersion,
      dto.reason.trim(),
      this.actor(request),
    );
  }

  private actor(request: any) {
    return { actorUserId: request.user.userId, ip: request.ip };
  }
}
