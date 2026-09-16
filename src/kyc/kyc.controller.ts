import { BadRequestException, Controller, Get, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { UploadedFiles } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { KycService } from './kyc.service';
import { EvidenceErrorCode } from '../common/errors/evidence-error-codes';

const allowedKycMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

@UseGuards(JwtAuthGuard)
@Controller('kyc')
export class KycController {
  constructor(private kycService: KycService) {}

  @Post('submit')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'idFront', maxCount: 1 },
        { name: 'idBack', maxCount: 1 },
        { name: 'selfie', maxCount: 1 },
      ],
      {
        limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per file
        fileFilter: (_req, file, callback) => {
          if (!allowedKycMimeTypes.has(file.mimetype)) {
            return callback(new BadRequestException({ message: 'صيغة ملف التحقق غير مدعومة', code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED }), false);
          }
          callback(null, true);
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
  getStatus(@Req() req: any) {
    return this.kycService.getStatus(req.user.userId);
  }

}
