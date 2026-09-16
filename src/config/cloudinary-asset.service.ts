import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { KycAssetMetadata } from '../users/schemas/user.schema';
import { CLOUDINARY } from './cloudinary.provider';

@Injectable()
export class CloudinaryAssetService {
  private readonly logger = new Logger(CloudinaryAssetService.name);

  constructor(@Inject(CLOUDINARY) private readonly cloudinary: any) {}

  private assetFormat(asset: KycAssetMetadata): string | undefined {
    if (asset.format) return asset.format;

    try {
      const extension = new URL(asset.secureUrl).pathname
        .split('.')
        .pop()
        ?.toLowerCase();
      return ['jpg', 'jpeg', 'png', 'webp'].includes(extension ?? '')
        ? extension
        : undefined;
    } catch {
      return undefined;
    }
  }

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

  async downloadAuthenticatedAsset(
    asset: KycAssetMetadata,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const format = this.assetFormat(asset);
    const signedUrl = this.cloudinary.url(asset.publicId, {
      secure: true,
      sign_url: true,
      resource_type: asset.resourceType,
      type: asset.deliveryType,
      ...(format ? { format } : {}),
    });

    try {
      const response = await fetch(signedUrl, {
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Cloudinary download rejected');

      const contentType = response.headers.get('content-type')?.split(';')[0] ?? '';
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
        throw new Error('Unexpected KYC asset content type');
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
        throw new Error('Unexpected KYC asset size');
      }

      return { buffer, contentType };
    } catch {
      this.logger.error('Cloudinary authenticated KYC asset download failed');
      throw new ServiceUnavailableException(
        'تعذر تحميل مستند التحقق بأمان، حاول مرة أخرى لاحقاً',
      );
    }
  }
}
