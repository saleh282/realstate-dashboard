import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { EvidenceErrorCode } from '../common/errors/evidence-error-codes';
import { CloudinaryAssetService } from '../config/cloudinary-asset.service';
import { BrokerApplicationsService } from './broker-applications.service';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { Capability } from '../authorization/capability';

@UseGuards(JwtAuthGuard, CapabilityGuard)
@RequireCapabilities(Capability.BROKER_APPLICATION_READ_OWN)
@Controller('broker')
export class BrokerApplicationsController {
  constructor(
    private readonly brokerApplications: BrokerApplicationsService,
    private readonly assets: CloudinaryAssetService,
  ) {}

  @Post('applications')
  @RequireCapabilities(Capability.BROKER_APPLICATION_SUBMIT)
  @UseInterceptors(
    FileFieldsInterceptor([{ name: 'verificationDocument', maxCount: 2 }], {
      limits: { fileSize: 10 * 1024 * 1024, files: 2 },
      fileFilter: (_request, file, callback) => {
        if (file.mimetype !== 'application/pdf') {
          return callback(
            new BadRequestException({
              message: 'صيغة مستند الوسيط غير مدعومة',
              code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED,
            }),
            false,
          );
        }
        callback(null, true);
      },
    }),
  )
  submit(
    @Req() request: any,
    @UploadedFiles() files: { verificationDocument?: Express.Multer.File[] },
    @Headers('idempotency-key') idempotencyKey: string,
  ) {
    return this.brokerApplications.submitApplication(
      request.user.userId,
      files?.verificationDocument ?? [],
      idempotencyKey,
      request.ip,
    );
  }

  @Get('applications/me')
  ownHistory(@Req() request: any) {
    return this.brokerApplications.listOwnApplications(request.user.userId);
  }

  @Get('applications/:applicationId/documents/:documentId')
  async getOwnDocument(
    @Param('applicationId') applicationId: string,
    @Param('documentId') documentId: string,
    @Req() request: any,
    @Res({ passthrough: true }) response: Response,
  ) {
    const asset = await this.brokerApplications.getEvidenceForApplicant(
      request.user.userId,
      applicationId,
      documentId,
      request.ip,
    );
    return this.download(asset, response);
  }

  private async download(asset: any, response: Response) {
    const downloaded = await this.assets.downloadAuthenticatedAsset(asset);
    response.set({
      'Content-Type': downloaded.contentType,
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(downloaded.buffer);
  }
}
