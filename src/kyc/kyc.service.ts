import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import * as streamifier from 'streamifier';
import { UsersService } from '../users/users.service';
import { KycStatus } from '../users/schemas/user.schema';
import { CLOUDINARY } from '../config/cloudinary.provider';
import { ReviewKycDto } from './dto/review-kyc.dto';

@Injectable()
export class KycService {
  constructor(
    private usersService: UsersService,
    @Inject(CLOUDINARY) private cloudinary: any,
  ) {}

  private uploadToCloudinary(file: Express.Multer.File, folder: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const uploadStream = this.cloudinary.uploader.upload_stream(
        { folder: `real-estate-auction/kyc/${folder}`, resource_type: 'image' },
        (error: any, result: any) => {
          if (error) return reject(new BadRequestException('فشل رفع الصورة'));
          resolve(result.secure_url);
        },
      );
      streamifier.createReadStream(file.buffer).pipe(uploadStream);
    });
  }

  // Screen 6: (KYC) 
  async submit(
    userId: string,
    files: {
      idFront?: Express.Multer.File[];
      idBack?: Express.Multer.File[];
      selfie?: Express.Multer.File[];
    },
  ) {
    const user = await this.usersService.findById(userId);
    if (!user) throw new NotFoundException('المستخدم غير موجود');

    if (!files.idFront?.[0] || !files.idBack?.[0] || !files.selfie?.[0]) {
      throw new BadRequestException(
        'يرجى إرفاق صورة الهوية (الوجه الأمامي والخلفي) والصورة الشخصية',
      );
    }

    const [idFrontUrl, idBackUrl, selfieUrl] = await Promise.all([
      this.uploadToCloudinary(files.idFront[0], 'id-front'),
      this.uploadToCloudinary(files.idBack[0], 'id-back'),
      this.uploadToCloudinary(files.selfie[0], 'selfie'),
    ]);

    user.idFrontUrl = idFrontUrl;
    user.idBackUrl = idBackUrl;
    user.selfieUrl = selfieUrl;
    user.kycStatus = KycStatus.PENDING;
    user.kycSubmittedAt = new Date();
    user.kycRejectionReason = undefined;

    await this.usersService.save(user);

    return {
      userId: user._id.toString(),
      id: user._id.toString(),
      message: 'تم إرسال بياناتك للتحقق، سيتم إعلامك بالنتيجة قريباً',
      kycStatus: user.kycStatus,
    };
  }

  async getStatus(userId: string) {
    const user = await this.usersService.findById(userId);
    if (!user) throw new NotFoundException('المستخدم غير موجود');

    return {
      userId: user._id.toString(),
      id: user._id.toString(),
      kycStatus: user.kycStatus,
      kycSubmittedAt: user.kycSubmittedAt,
      kycReviewedAt: user.kycReviewedAt,
      kycRejectionReason: user.kycRejectionReason,
    };
  }

  // Admin/back-office action - approve or reject a pending submission
  async review(userId: string, dto: ReviewKycDto) {
    const user = await this.usersService.findById(userId);
    if (!user) throw new NotFoundException('المستخدم غير موجود');

    user.kycStatus = dto.decision === 'verified' ? KycStatus.VERIFIED : KycStatus.REJECTED;
    user.kycReviewedAt = new Date();
    user.kycRejectionReason = dto.decision === 'rejected' ? dto.rejectionReason : undefined;

    await this.usersService.save(user);
    return {
      userId: user._id.toString(),
      id: user._id.toString(),
      kycStatus: user.kycStatus,
    };
  }
}
