import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User, UserDocument } from './schemas/user.schema';
import { RefreshTokenService } from '../refresh-token/refresh-token.service';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { CloudinaryAssetService } from '../config/cloudinary-asset.service';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private refreshTokenService: RefreshTokenService,
    private auditLogService: AuditLogService,
    private cloudinaryAssetService: CloudinaryAssetService,
  ) {}

  static isEmail(identifier: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
  }

  async findByIdentifier(identifier: string, withSecrets = false) {
    const query = UsersService.isEmail(identifier)
      ? { email: identifier.toLowerCase() }
      : { phone: identifier };

    const q = this.userModel.findOne(query);
    if (withSecrets) {
      q.select('+password +failedLoginAttempts +accountLockedUntil');
    }
    return q.exec();
  }

  async findById(id: string, withSecrets = false) {
    const q = this.userModel.findById(id);
    if (withSecrets) {
      q.select('+password +failedLoginAttempts +accountLockedUntil');
    }
    return q.exec();
  }

  async getProfile(userId: string) {
    const user = await this.userModel.findById(userId).exec();
    if (!user) {
      throw new NotFoundException('المستخدم غير موجود');
    }

    return {
      userId: user._id.toString(),
      id: user._id.toString(),
      _id: user._id.toString(),
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      emailVerified: user.emailVerified,
      role: user.role,
      kycStatus: user.kycStatus,
      idFrontUrl: user.idFrontUrl,
      idBackUrl: user.idBackUrl,
      selfieUrl: user.selfieUrl,
      kycSubmittedAt: user.kycSubmittedAt,
      kycReviewedAt: user.kycReviewedAt,
      kycRejectionReason: user.kycRejectionReason,
      createdAt: (user as any).createdAt,
      updatedAt: (user as any).updatedAt,
    };
  }

  async deleteAccount(userId: string, password: string, ip?: string) {
    const user = await this.findById(userId, true);
    if (!user) {
      throw new NotFoundException('المستخدم غير موجود');
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      throw new UnauthorizedException('كلمة المرور غير صحيحة لتأكيد حذف الحساب');
    }

    // Delete KYC assets whose Cloudinary identifiers are available before removing
    // their only database references. Legacy URL-only assets are documented separately.
    await this.cloudinaryAssetService.deleteAssets([
      user.idFrontAsset,
      user.idBackAsset,
      user.selfieAsset,
    ]);

    // 1. Revoke all refresh tokens
    await this.refreshTokenService.revokeAllForUser(userId);

    // 2. Audit log the account deletion
    await this.auditLogService.log(AuditAction.ACCOUNT_DELETED, userId, ip);

    // 3. Permanently remove the user document
    await this.userModel.findByIdAndDelete(userId).exec();

    return {
      message: 'تم حذف الحساب نهائياً بنجاح',
      userId,
    };
  }

  async create(data: Partial<User>) {
    return this.userModel.create(data);
  }

  async save(user: UserDocument) {
    return user.save();
  }
}
