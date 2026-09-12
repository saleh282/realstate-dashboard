import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { KycAssetMetadata } from '../users/schemas/user.schema';
import { CLOUDINARY } from './cloudinary.provider';

@Injectable()
export class CloudinaryAssetService {
  private readonly logger = new Logger(CloudinaryAssetService.name);

  constructor(@Inject(CLOUDINARY) private readonly cloudinary: any) {}

  async deleteAssets(assets: Array<KycAssetMetadata | undefined>): Promise<void> {
    const existingAssets = assets.filter((asset): asset is KycAssetMetadata => Boolean(asset?.publicId));
    if (!existingAssets.length) return;

    try {
      await Promise.all(
        existingAssets.map((asset) =>
          this.cloudinary.uploader.destroy(asset.publicId, {
            resource_type: asset.resourceType,
            type: asset.deliveryType,
            invalidate: true,
          }),
        ),
      );
    } catch (error) {
      this.logger.error('Cloudinary KYC asset deletion failed');
      throw new ServiceUnavailableException('تعذر حذف مستندات التحقق بأمان، حاول مرة أخرى لاحقاً');
    }
  }
}
