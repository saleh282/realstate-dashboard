import { BadRequestException, Controller, Get, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { BoundedFileFields } from '../common/uploads/bounded-upload.interceptor';
import { UPLOAD_REQUEST_LIMITS } from '../common/uploads/upload-policies';
import { UploadedFiles } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { KycService } from './kyc.service';
import { EvidenceErrorCode } from '../common/errors/evidence-error-codes';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { Capability } from '../authorization/capability';

const allowedKycMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

@UseGuards(JwtAuthGuard, CapabilityGuard)
@Controller('kyc')
export class KycController {
  constructor(private kycService: KycService) {}

  @Post('submit')
  @RequireCapabilities(Capability.KYC_SELF_SUBMIT)
  @UseInterceptors(
    BoundedFileFields(
      [
        { name: 'idFront', maxCount: 1 },
        { name: 'idBack', maxCount: 1 },
        { name: 'selfie', maxCount: 1 },
      ],
      {
        maxRequestBytes: UPLOAD_REQUEST_LIMITS.kyc,
        multer: {
          limits: { fileSize: 5 * 1024 * 1024, files: 3 }, // 5MB per file
          fileFilter: (_req, file, callback) => {
            if (!allowedKycMimeTypes.has(file.mimetype)) {
              return callback(new BadRequestException({ message: 'صيغة ملف التحقق غير مدعومة', code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED }), false);
            }
            callback(null, true);
          },
        },
      },
    ),
  )
  submit(
    @Req() req: any,
    @UploadedFiles()
    files: {
      idFront?: Express.Multer.File[];
      idBack?: Express.Multer.File[];
      selfie?: Express.Multer.File[];
    },
  ) {
    return this.kycService.submit(req.user.userId, files);
  }

  @Get('status')
  @RequireCapabilities(Capability.KYC_SELF_READ)
  getStatus(@Req() req: any) {
    return this.kycService.getStatus(req.user.userId);
  }

}
