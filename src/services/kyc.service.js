'use strict';

const { BadRequestException, NotFoundException } = require('../common/http/errors');
const { validateEvidenceFile } = require('../common/uploads/evidence-file.validator');
const { AssetClassification } = require('../config/evidence-asset.types');
const { KycStatus } = require('../models/user.model');
const KYC_POLICY = { kind: 'image', maxBytes: 5 * 1024 * 1024, maxImagePixels: 40_000_000 };
class KycService {
  constructor(usersService, assets) {
    this.usersService = usersService;
    this.assets = assets;
  }
  async submit(userId, files) {
    const user = await this.usersService.findById(userId);
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    if (!files.idFront?.[0] || !files.idBack?.[0] || !files.selfie?.[0]) {
      throw new BadRequestException(
        'يرجى إرفاق صورة الهوية (الوجه الأمامي والخلفي) والصورة الشخصية',
      );
    }
    const input = [files.idFront[0], files.idBack[0], files.selfie[0]];
    const detected = input.map((file) => validateEvidenceFile(file, KYC_POLICY));
    const uploads = await Promise.allSettled([
      this.assets.uploadPrivateEvidence(
        input[0],
        'kyc/id-front',
        AssetClassification.PRIVATE_KYC_EVIDENCE,
        detected[0],
      ),
      this.assets.uploadPrivateEvidence(
        input[1],
        'kyc/id-back',
        AssetClassification.PRIVATE_KYC_EVIDENCE,
        detected[1],
      ),
      this.assets.uploadPrivateEvidence(
        input[2],
        'kyc/selfie',
        AssetClassification.PRIVATE_KYC_EVIDENCE,
        detected[2],
      ),
    ]);
    const successful = uploads
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value);
    if (uploads.some((result) => result.status === 'rejected')) {
      await this.assets.deleteOrEnqueue(successful, 'partial-kyc-upload');
      const rejected = uploads.find((result) => result.status === 'rejected');
      throw rejected?.reason ?? new BadRequestException('فشل رفع صور التحقق');
    }
    const [idFrontAsset, idBackAsset, selfieAsset] = successful;
    const oldAssets = [user.idFrontAsset, user.idBackAsset, user.selfieAsset]
      .filter(Boolean)
      .map((asset) => this.normalizeLegacyAsset(asset));
    user.idFrontUrl = undefined;
    user.idBackUrl = undefined;
    user.selfieUrl = undefined;
    user.idFrontAsset = idFrontAsset;
    user.idBackAsset = idBackAsset;
    user.selfieAsset = selfieAsset;
    user.kycStatus = KycStatus.PENDING;
    user.kycSubmittedAt = new Date();
    user.kycReviewedAt = undefined;
    user.kycRejectionReason = undefined;
    user.kycVersion = (user.kycVersion ?? 0) + 1;
    try {
      await this.usersService.save(user);
    } catch (error) {
      await this.assets.deleteOrEnqueue(successful, 'kyc-database-write-failed');
      throw error;
    }
    await this.assets.deleteOrEnqueue(oldAssets, 'kyc-evidence-replaced');
    return {
      userId: user._id.toString(),
      id: user._id.toString(),
      message: 'تم إرسال بياناتك للتحقق، سيتم إعلامك بالنتيجة قريباً',
      kycStatus: user.kycStatus,
      kycVersion: user.kycVersion,
    };
  }
  async getStatus(userId) {
    const user = await this.usersService.findById(userId);
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    return {
      userId: user._id.toString(),
      id: user._id.toString(),
      kycStatus: user.kycStatus,
      kycVersion: user.kycVersion,
      kycSubmittedAt: user.kycSubmittedAt,
      kycReviewedAt: user.kycReviewedAt,
      kycRejectionReason: user.kycRejectionReason,
    };
  }
  normalizeLegacyAsset(asset) {
    return {
      ...asset,
      resourceType: asset.resourceType ?? 'image',
      deliveryType: asset.deliveryType ?? 'authenticated',
      classification: asset.classification ?? AssetClassification.PRIVATE_KYC_EVIDENCE,
    };
  }
}

Object.assign(exports, { KycService });
