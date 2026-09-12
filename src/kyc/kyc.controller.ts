import { BadRequestException, Controller, Get, Param, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { UploadedFiles, Body } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { KycService } from './kyc.service';
import { ReviewKycDto } from './dto/review-kyc.dto';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UserRole } from '../auth/roles.enum';

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
            return callback(new BadRequestException('صيغة ملف التحقق غير مدعومة'), false);
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

  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  @Post('review/:userId')
  review(@Param('userId') userId: string, @Body() dto: ReviewKycDto) {
    return this.kycService.review(userId, dto);
  }
}
