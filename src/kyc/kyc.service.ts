import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import * as streamifier from 'streamifier';
import { UsersService } from '../users/users.service';
import { KycAssetMetadata, KycStatus } from '../users/schemas/user.schema';
import { CLOUDINARY } from '../config/cloudinary.provider';
import { ReviewKycDto } from './dto/review-kyc.dto';

@Injectable()
export class KycService {
  constructor(
    private usersService: UsersService,
    @Inject(CLOUDINARY) private cloudinary: any,
  ) {}

  private isExpectedImage(file: Express.Multer.File): boolean {
    const bytes = file.buffer;
    const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isPng =
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isWebp =
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    return ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype) && (isJpeg || isPng || isWebp);
  }

  private uploadToCloudinary(file: Express.Multer.File, folder: string): Promise<KycAssetMetadata> {
    return new Promise((resolve, reject) => {
      const uploadStream = this.cloudinary.uploader.upload_stream(
        {
          folder: `real-estate-auction/kyc/${folder}`,
          resource_type: 'image',
          type: 'authenticated',
          access_mode: 'authenticated',
        },
        (error: any, result: any) => {
          if (error) return reject(new BadRequestException('فشل رفع الصورة'));
          resolve({
            publicId: result.public_id,
            secureUrl: result.secure_url,
            resourceType: 'image',
            deliveryType: 'authenticated',
          });
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

    const uploadFiles = [files.idFront[0], files.idBack[0], files.selfie[0]];
    if (uploadFiles.some((file) => !this.isExpectedImage(file))) {
      throw new BadRequestException('صيغة أحد ملفات التحقق غير مدعومة أو لا تطابق محتواه');
    }

    const uploaded = await Promise.allSettled([
      this.uploadToCloudinary(files.idFront[0], 'id-front'),
      this.uploadToCloudinary(files.idBack[0], 'id-back'),
      this.uploadToCloudinary(files.selfie[0], 'selfie'),
    ]);

    const successfulAssets = uploaded
      .filter((result): result is PromiseFulfilledResult<KycAssetMetadata> => result.status === 'fulfilled')
      .map((result) => result.value);
    if (uploaded.some((result) => result.status === 'rejected')) {
      await Promise.allSettled(
        successfulAssets.map((asset) =>
          this.cloudinary.uploader.destroy(asset.publicId, {
            resource_type: asset.resourceType,
            type: asset.deliveryType,
            invalidate: true,
          }),
        ),
      );
      throw new BadRequestException('فشل رفع صور التحقق');
    }

    const [idFrontAsset, idBackAsset, selfieAsset] = successfulAssets;
    const oldAssets = [user.idFrontAsset, user.idBackAsset, user.selfieAsset];

    user.idFrontUrl = idFrontAsset.secureUrl;
    user.idBackUrl = idBackAsset.secureUrl;
    user.selfieUrl = selfieAsset.secureUrl;
    user.idFrontAsset = idFrontAsset;
    user.idBackAsset = idBackAsset;
    user.selfieAsset = selfieAsset;
    user.kycStatus = KycStatus.PENDING;
    user.kycSubmittedAt = new Date();
    user.kycRejectionReason = undefined;

    await this.usersService.save(user);

    await Promise.allSettled(
      oldAssets
        .filter((asset): asset is KycAssetMetadata => Boolean(asset?.publicId))
        .map((asset) =>
          this.cloudinary.uploader.destroy(asset.publicId, {
            resource_type: asset.resourceType,
            type: asset.deliveryType,
            invalidate: true,
          }),
        ),
    );

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
