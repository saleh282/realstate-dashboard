import { Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as streamifier from 'streamifier';
import { EvidenceErrorCode } from '../common/errors/evidence-error-codes';
import { DetectedEvidenceFile } from '../common/uploads/evidence-file.validator';
import { AssetClassification, StoredAssetMetadata } from './evidence-asset.types';
import { CLOUDINARY } from './cloudinary.provider';
import { EvidenceCleanupTask, EvidenceCleanupTaskDocument } from './schemas/evidence-cleanup-task.schema';

@Injectable()
export class CloudinaryAssetService {
  private readonly logger = new Logger(CloudinaryAssetService.name);

  constructor(
    @Inject(CLOUDINARY) private readonly cloudinary: any,
    @Optional() @InjectModel(EvidenceCleanupTask.name)
    private readonly cleanupTasks?: Model<EvidenceCleanupTaskDocument>,
  ) {}

  async uploadPublicPropertyMedia(
    file: Express.Multer.File,
    detected: DetectedEvidenceFile,
  ): Promise<StoredAssetMetadata & { secureUrl: string }> {
    if (detected.mime === 'application/pdf') {
      throw new ServiceUnavailableException({
        message: 'صيغة صورة العقار غير مدعومة',
        code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED,
      });
    }
    try {
      const result = await new Promise<any>((resolve, reject) => {
        const stream = this.cloudinary.uploader.upload_stream(
          {
            folder: 'real-estate-auction/public/properties/photos',
            resource_type: 'image',
            type: 'upload',
            use_filename: false,
            unique_filename: true,
            overwrite: false,
          },
          (error: unknown, uploadResult: unknown) =>
            error || !uploadResult ? reject(error ?? new Error('Missing upload result')) : resolve(uploadResult),
        );
        streamifier.createReadStream(file.buffer).pipe(stream);
      });
      return {
        publicId: result.public_id,
        secureUrl: result.secure_url,
        resourceType: 'image',
        deliveryType: 'upload',
        classification: AssetClassification.PUBLIC_PROPERTY_MEDIA,
        format: detected.format,
        bytes: file.buffer.length,
      };
    } catch {
      this.logger.error('Public property media upload failed');
      throw new ServiceUnavailableException({
        message: 'تعذر رفع صورة العقار، حاول مرة أخرى لاحقاً',
        code: EvidenceErrorCode.UPLOAD_FAILED,
      });
    }
  }

  async uploadPrivateEvidence(
    file: Express.Multer.File,
    folder: string,
    classification: Exclude<AssetClassification, AssetClassification.PUBLIC_PROPERTY_MEDIA>,
    detected: DetectedEvidenceFile,
  ): Promise<StoredAssetMetadata> {
    const resourceType = detected.mime === 'application/pdf' ? 'raw' : 'image';
    try {
      const result = await new Promise<any>((resolve, reject) => {
        const stream = this.cloudinary.uploader.upload_stream(
          {
            folder: `real-estate-auction/private/${folder}`,
            resource_type: resourceType,
            type: 'authenticated',
            access_mode: 'authenticated',
            use_filename: false,
            unique_filename: true,
            overwrite: false,
          },
          (error: unknown, uploadResult: unknown) =>
            error || !uploadResult ? reject(error ?? new Error('Missing upload result')) : resolve(uploadResult),
        );
        streamifier.createReadStream(file.buffer).pipe(stream);
      });
      return {
        publicId: result.public_id,
        resourceType,
        deliveryType: 'authenticated',
        classification,
        format: detected.format,
        bytes: file.buffer.length,
      };
    } catch {
      this.logger.error(`Private evidence upload failed (${classification})`);
      throw new ServiceUnavailableException({
        message: 'تعذر رفع ملف الإثبات بأمان، حاول مرة أخرى لاحقاً',
        code: EvidenceErrorCode.UPLOAD_FAILED,
      });
    }
  }

  async deleteAssets(assets: Array<StoredAssetMetadata | undefined>): Promise<void> {
    const existing = assets.filter((asset): asset is StoredAssetMetadata => Boolean(asset?.publicId));
    if (!existing.length) return;
    try {
      await Promise.all(existing.map((asset) => this.destroy(asset)));
    } catch {
      this.logger.error('Private evidence deletion failed');
      throw new ServiceUnavailableException({
        message: 'تعذر حذف ملفات الإثبات بأمان، حاول مرة أخرى لاحقاً',
        code: EvidenceErrorCode.UPLOAD_FAILED,
      });
    }
  }

  async deleteOrEnqueue(assets: Array<StoredAssetMetadata | undefined>, reason: string): Promise<void> {
    const existing = assets.filter((asset): asset is StoredAssetMetadata => Boolean(asset?.publicId));
    await Promise.all(existing.map(async (asset) => {
      try {
        await this.destroy(asset);
      } catch (error) {
        this.logger.warn(`Evidence cleanup queued (${asset.classification})`);
        if (!this.cleanupTasks) return;
        await this.cleanupTasks.updateOne(
          { publicId: asset.publicId },
          {
            $setOnInsert: {
              publicId: asset.publicId,
              resourceType: asset.resourceType,
              deliveryType: asset.deliveryType ?? 'upload',
              classification: asset.classification,
              reason: reason.slice(0, 100),
              status: 'pending',
            },
            $set: { lastError: this.safeError(error) },
            $inc: { attempts: 1 },
          },
          { upsert: true },
        ).exec();
      }
    }));
  }

  async reconcilePendingCleanup(limit = 50): Promise<{ processed: number; completed: number }> {
    if (!this.cleanupTasks) return { processed: 0, completed: 0 };
    const tasks = await this.cleanupTasks.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(Math.min(Math.max(limit, 1), 100)).exec();
    let completed = 0;
    for (const task of tasks) {
      try {
        await this.destroy(task.toObject() as StoredAssetMetadata);
        await this.cleanupTasks.updateOne(
          { _id: task._id, status: 'pending' },
          { $set: { status: 'completed', completedAt: new Date() }, $inc: { attempts: 1 }, $unset: { lastError: 1 } },
        ).exec();
        completed += 1;
      } catch (error) {
        await this.cleanupTasks.updateOne(
          { _id: task._id, status: 'pending' },
          { $set: { lastError: this.safeError(error) }, $inc: { attempts: 1 } },
        ).exec();
      }
    }
    return { processed: tasks.length, completed };
  }

  async downloadAuthenticatedAsset(asset: StoredAssetMetadata): Promise<{ buffer: Buffer; contentType: string }> {
    const format = asset.format ?? this.legacyFormat(asset.secureUrl);
    const legacyPublic = !asset.deliveryType || asset.deliveryType === 'upload';
    const deliveryUrl = legacyPublic && asset.secureUrl
      ? asset.secureUrl
      : this.cloudinary.url(asset.publicId, {
          secure: true,
          sign_url: true,
          resource_type: asset.resourceType,
          type: 'authenticated',
          ...(format ? { format } : {}),
        });
    try {
      const response = await fetch(deliveryUrl, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('Provider download rejected');
      const contentType = response.headers.get('content-type')?.split(';')[0] ?? '';
      if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(contentType)) {
        throw new Error('Unexpected private evidence content type');
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > 10 * 1024 * 1024) throw new Error('Unexpected private evidence size');
      return { buffer, contentType };
    } catch {
      this.logger.error(`Private evidence delivery failed (${asset.classification})`);
      throw new ServiceUnavailableException({
        message: 'تعذر تحميل ملف الإثبات بأمان، حاول مرة أخرى لاحقاً',
        code: EvidenceErrorCode.DELIVERY_FAILED,
      });
    }
  }

  private destroy(asset: StoredAssetMetadata): Promise<unknown> {
    return this.cloudinary.uploader.destroy(asset.publicId, {
      resource_type: asset.resourceType,
      type: asset.deliveryType ?? 'upload',
      invalidate: true,
    });
  }

  private legacyFormat(url?: string): StoredAssetMetadata['format'] | undefined {
    if (!url) return undefined;
    try {
      const extension = new URL(url).pathname.split('.').pop()?.toLowerCase();
      return ['jpg', 'jpeg', 'png', 'webp', 'pdf'].includes(extension ?? '')
        ? (extension as StoredAssetMetadata['format']) : undefined;
    } catch { return undefined; }
  }

  private safeError(error: unknown): string {
    return (error instanceof Error ? error.name : 'ProviderError').slice(0, 500);
  }
}
