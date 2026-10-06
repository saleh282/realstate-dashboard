'use strict';

const { Logger } = require('../common/logging/logger');
const { ServiceUnavailableException } = require('../common/http/errors');
const streamifier = require('streamifier');
const { EvidenceErrorCode } = require('../common/errors/evidence-error-codes');
const { AssetClassification } = require('../config/evidence-asset.types');
const CLEANUP_LEASE_MS = 5 * 60_000;
const CLEANUP_MAX_BACKOFF_MS = 6 * 60 * 60_000;
function cleanupBackoffMs(attempt) {
  return Math.min(60_000 * 2 ** Math.min(Math.max(attempt, 1), 12), CLEANUP_MAX_BACKOFF_MS);
}
class CloudinaryAssetService {
  constructor(cloudinary, cleanupTasks) {
    this.cloudinary = cloudinary;
    this.cleanupTasks = cleanupTasks;
    this.logger = new Logger(CloudinaryAssetService.name);
  }
  /**
   * Stores a user's profile photo for public delivery. The image is cropped
   * to a square around the face on upload, so the original is never kept.
   */
  async uploadPublicProfilePhoto(file, detected) {
    try {
      const result = await new Promise((resolve, reject) => {
        const stream = this.cloudinary.uploader.upload_stream(
          {
            folder: 'real-estate-auction/public/users/photos',
            resource_type: 'image',
            type: 'upload',
            use_filename: false,
            unique_filename: true,
            overwrite: false,
            transformation: [{ width: 512, height: 512, crop: 'fill', gravity: 'face' }],
          },
          (error, uploadResult) =>
            error || !uploadResult
              ? reject(error ?? new Error('Missing upload result'))
              : resolve(uploadResult),
        );
        streamifier.createReadStream(file.buffer).pipe(stream);
      });
      return {
        publicId: result.public_id,
        secureUrl: result.secure_url,
        resourceType: 'image',
        deliveryType: 'upload',
        classification: AssetClassification.PUBLIC_PROFILE_PHOTO,
        format: detected.format === 'pdf' ? undefined : detected.format,
        bytes: file.buffer.length,
      };
    } catch {
      this.logger.error('Profile photo upload failed');
      throw new ServiceUnavailableException({
        message: 'تعذر رفع الصورة الشخصية، حاول مرة أخرى لاحقاً',
        code: EvidenceErrorCode.UPLOAD_FAILED,
      });
    }
  }
  /**
   * Stores a photo of a listing for public delivery, scaled down to what a
   * phone screen can show.
   */
  async uploadListingPhoto(file, detected) {
    const result = await this.uploadPublicMedia(file, {
      folder: 'real-estate/public/listings/photos',
      resource_type: 'image',
      transformation: [{ width: 1600, height: 1600, crop: 'limit', quality: 'auto' }],
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
  }
  /** Stores the video of a listing for public delivery. `duration` is in seconds. */
  async uploadListingVideo(file) {
    const result = await this.uploadPublicMedia(file, {
      folder: 'real-estate/public/listings/videos',
      resource_type: 'video',
    });
    return {
      publicId: result.public_id,
      secureUrl: result.secure_url,
      resourceType: 'video',
      deliveryType: 'upload',
      classification: AssetClassification.PUBLIC_PROPERTY_MEDIA,
      bytes: file.buffer.length,
      duration: typeof result.duration === 'number' ? result.duration : undefined,
    };
  }
  async uploadPublicMedia(file, options) {
    try {
      return await new Promise((resolve, reject) => {
        const stream = this.cloudinary.uploader.upload_stream(
          {
            type: 'upload',
            use_filename: false,
            unique_filename: true,
            overwrite: false,
            ...options,
          },
          (error, uploadResult) =>
            error || !uploadResult
              ? reject(error ?? new Error('Missing upload result'))
              : resolve(uploadResult),
        );
        streamifier.createReadStream(file.buffer).pipe(stream);
      });
    } catch {
      this.logger.error(`Listing ${options.resource_type} upload failed`);
      throw new ServiceUnavailableException({
        message: 'تعذر رفع الملف، حاول مرة أخرى لاحقاً',
        code: EvidenceErrorCode.UPLOAD_FAILED,
      });
    }
  }
  async uploadPrivateEvidence(file, folder, classification, detected) {
    const resourceType = detected.mime === 'application/pdf' ? 'raw' : 'image';
    try {
      const result = await new Promise((resolve, reject) => {
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
          (error, uploadResult) =>
            error || !uploadResult
              ? reject(error ?? new Error('Missing upload result'))
              : resolve(uploadResult),
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
  async deleteOrEnqueue(assets, reason) {
    const existing = assets.filter((asset) => Boolean(asset?.publicId));
    await Promise.all(
      existing.map(async (asset) => {
        try {
          await this.destroy(asset);
        } catch (error) {
          this.logger.warn(`Evidence cleanup queued (${asset.classification})`);
          if (!this.cleanupTasks) return;
          await this.cleanupTasks
            .updateOne(
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
            )
            .exec();
        }
      }),
    );
  }
  /**
   * Retries queued deletions. Each task is claimed atomically (its
   * nextAttemptAt is pushed out by a lease) so concurrent workers never process
   * the same task; failures back off exponentially so a permanently failing
   * task cannot starve the ones behind it. Cloudinary treats destroying an
   * already-deleted asset as success, which keeps the operation idempotent.
   */
  async reconcilePendingCleanup(limit = 50, options = {}) {
    if (!this.cleanupTasks) return { processed: 0, completed: 0, failed: 0 };
    const batchSize = Math.min(Math.max(Math.trunc(limit) || 1, 1), 100);
    const leaseMs = options.leaseMs ?? CLEANUP_LEASE_MS;
    let processed = 0;
    let completed = 0;
    let failed = 0;
    for (let index = 0; index < batchSize; index++) {
      const now = new Date();
      const task = await this.cleanupTasks
        .findOneAndUpdate(
          { status: 'pending', $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
          { $set: { nextAttemptAt: new Date(now.getTime() + leaseMs) } },
          { sort: { createdAt: 1 }, new: true },
        )
        .exec();
      if (!task) break;
      processed += 1;
      try {
        await this.destroy(task.toObject());
        await this.cleanupTasks
          .updateOne(
            { _id: task._id, status: 'pending' },
            {
              $set: { status: 'completed', completedAt: new Date() },
              $inc: { attempts: 1 },
              $unset: { lastError: 1, nextAttemptAt: 1 },
            },
          )
          .exec();
        completed += 1;
      } catch (error) {
        failed += 1;
        await this.cleanupTasks
          .updateOne(
            { _id: task._id, status: 'pending' },
            {
              $set: {
                lastError: this.safeError(error),
                nextAttemptAt: new Date(Date.now() + cleanupBackoffMs((task.attempts ?? 0) + 1)),
              },
              $inc: { attempts: 1 },
            },
          )
          .exec();
      }
    }
    return { processed, completed, failed };
  }
  /** Backlog figures for alerting; never includes asset identifiers. */
  async cleanupBacklog(stuckAttempts = 5) {
    if (!this.cleanupTasks) return { pending: 0, stuck: 0, oldestPendingAgeSeconds: null };
    const [pending, stuck, oldest] = await Promise.all([
      this.cleanupTasks.countDocuments({ status: 'pending' }).exec(),
      this.cleanupTasks
        .countDocuments({ status: 'pending', attempts: { $gte: stuckAttempts } })
        .exec(),
      this.cleanupTasks
        .findOne({ status: 'pending' })
        .sort({ createdAt: 1 })
        .select('createdAt')
        .lean()
        .exec(),
    ]);
    const createdAt = oldest?.createdAt;
    return {
      pending,
      stuck,
      oldestPendingAgeSeconds: createdAt
        ? Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / 1000))
        : null,
    };
  }
  async downloadAuthenticatedAsset(asset) {
    const format = asset.format ?? this.legacyFormat(asset.secureUrl);
    const legacyPublic = !asset.deliveryType || asset.deliveryType === 'upload';
    const shouldAppendFormat = Boolean(
      asset.resourceType !== 'raw' &&
      format &&
      !asset.publicId.toLowerCase().endsWith(`.${format.toLowerCase()}`),
    );
    const deliveryUrl =
      legacyPublic && asset.secureUrl
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
      const response = await fetch(deliveryUrl, {
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      });
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
  destroy(asset) {
    return this.cloudinary.uploader.destroy(asset.publicId, {
      resource_type: asset.resourceType,
      type: asset.deliveryType ?? 'upload',
      invalidate: true,
    });
  }
  legacyFormat(url) {
    if (!url) return undefined;
    try {
      const extension = new URL(url).pathname.split('.').pop()?.toLowerCase();
      return ['jpg', 'jpeg', 'png', 'webp', 'pdf'].includes(extension ?? '')
        ? extension
        : undefined;
    } catch {
      return undefined;
    }
  }
  safeError(error) {
    return (error instanceof Error ? error.name : 'ProviderError').slice(0, 500);
  }
}

Object.assign(exports, { cleanupBackoffMs, CloudinaryAssetService });
