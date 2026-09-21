import { Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as streamifier from 'streamifier';
import { EvidenceErrorCode } from '../common/errors/evidence-error-codes';
import { DetectedEvidenceFile } from '../common/uploads/evidence-file.validator';
import { AssetClassification, StoredAssetMetadata } from './evidence-asset.types';
import { CLOUDINARY } from './cloudinary.provider';
import { EvidenceCleanupTask, EvidenceCleanupTaskDocument } from './schemas/evidence-cleanup-task.schema';

const CLEANUP_LEASE_MS = 5 * 60_000;
const CLEANUP_MAX_BACKOFF_MS = 6 * 60 * 60_000;

export function cleanupBackoffMs(attempt: number): number {
  return Math.min(60_000 * 2 ** Math.min(Math.max(attempt, 1), 12), CLEANUP_MAX_BACKOFF_MS);
}

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

  /**
   * Retries queued deletions. Each task is claimed atomically (its
   * nextAttemptAt is pushed out by a lease) so concurrent workers never process
   * the same task; failures back off exponentially so a permanently failing
   * task cannot starve the ones behind it. Cloudinary treats destroying an
   * already-deleted asset as success, which keeps the operation idempotent.
   */
  async reconcilePendingCleanup(
    limit = 50,
    options: { leaseMs?: number } = {},
  ): Promise<{ processed: number; completed: number; failed: number }> {
    if (!this.cleanupTasks) return { processed: 0, completed: 0, failed: 0 };
    const batchSize = Math.min(Math.max(Math.trunc(limit) || 1, 1), 100);
    const leaseMs = options.leaseMs ?? CLEANUP_LEASE_MS;
    let processed = 0;
    let completed = 0;
    let failed = 0;
    for (let index = 0; index < batchSize; index++) {
      const now = new Date();
      const task = await this.cleanupTasks.findOneAndUpdate(
        { status: 'pending', $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
        { $set: { nextAttemptAt: new Date(now.getTime() + leaseMs) } },
        { sort: { createdAt: 1 }, new: true },
      ).exec();
      if (!task) break;
      processed += 1;
      try {
        await this.destroy(task.toObject() as StoredAssetMetadata);
        await this.cleanupTasks.updateOne(
          { _id: task._id, status: 'pending' },
          {
            $set: { status: 'completed', completedAt: new Date() },
            $inc: { attempts: 1 },
            $unset: { lastError: 1, nextAttemptAt: 1 },
          },
        ).exec();
        completed += 1;
      } catch (error) {
        failed += 1;
        await this.cleanupTasks.updateOne(
          { _id: task._id, status: 'pending' },
          {
            $set: {
              lastError: this.safeError(error),
              nextAttemptAt: new Date(Date.now() + cleanupBackoffMs((task.attempts ?? 0) + 1)),
            },
            $inc: { attempts: 1 },
          },
        ).exec();
      }
    }
    return { processed, completed, failed };
  }

  /** Backlog figures for alerting; never includes asset identifiers. */
  async cleanupBacklog(stuckAttempts = 5): Promise<{
    pending: number;
    stuck: number;
    oldestPendingAgeSeconds: number | null;
  }> {
    if (!this.cleanupTasks) return { pending: 0, stuck: 0, oldestPendingAgeSeconds: null };
    const [pending, stuck, oldest] = await Promise.all([
      this.cleanupTasks.countDocuments({ status: 'pending' }).exec(),
      this.cleanupTasks.countDocuments({ status: 'pending', attempts: { $gte: stuckAttempts } }).exec(),
      this.cleanupTasks.findOne({ status: 'pending' }).sort({ createdAt: 1 }).select('createdAt').lean().exec(),
    ]);
    const createdAt = (oldest as { createdAt?: Date } | null)?.createdAt;
    return {
      pending,
      stuck,
      oldestPendingAgeSeconds: createdAt ? Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / 1000)) : null,
    };
  }

  async downloadAuthenticatedAsset(asset: StoredAssetMetadata): Promise<{ buffer: Buffer; contentType: string }> {
    const format = asset.format ?? this.legacyFormat(asset.secureUrl);
    const legacyPublic = !asset.deliveryType || asset.deliveryType === 'upload';
    const shouldAppendFormat = Boolean(
      asset.resourceType !== 'raw' &&
      format &&
      !asset.publicId.toLowerCase().endsWith(`.${format.toLowerCase()}`),
    );
    const deliveryUrl = legacyPublic && asset.secureUrl
      ? asset.secureUrl
      : this.cloudinary.url(asset.publicId, {
          secure: true,
          sign_url: true,
          resource_type: asset.resourceType,
          type: 'authenticated',
          ...(shouldAppendFormat ? { format } : {}),
        });
    let failure = 'request_failed';
    try {
      const response = await fetch(deliveryUrl, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        failure = `http_${response.status}`;
        throw new Error('Provider download rejected');
      }
      let contentType = response.headers.get('content-type')?.split(';')[0] ?? '';
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > 10 * 1024 * 1024) {
        failure = `invalid_size_${buffer.length}`;
        throw new Error('Unexpected private evidence size');
      }
      if (
        asset.resourceType === 'raw' &&
        format === 'pdf' &&
        contentType === 'application/octet-stream' &&
        buffer.subarray(0, 5).toString('ascii') === '%PDF-' &&
        buffer.subarray(Math.max(0, buffer.length - 2048)).includes(Buffer.from('%%EOF'))
      ) {
        contentType = 'application/pdf';
      }
      if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(contentType)) {
        failure = `content_type_${contentType || 'missing'}`;
        throw new Error('Unexpected private evidence content type');
      }
      return { buffer, contentType };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') failure = 'timeout';
      this.logger.error(`Private evidence delivery failed (${asset.classification}; ${failure})`);
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
