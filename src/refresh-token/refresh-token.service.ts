import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { RefreshToken, RefreshTokenDocument } from './schemas/refresh-token.schema';

@Injectable()
export class RefreshTokenService {
  constructor(
    @InjectModel(RefreshToken.name) private tokenModel: Model<RefreshTokenDocument>,
  ) {}

  async store(userId: string, refreshToken: string, expiresAt: Date, device = 'unknown') {
    const tokenHash = await bcrypt.hash(refreshToken, 10);
    return this.tokenModel.create({ userId: new Types.ObjectId(userId), tokenHash, device, expiresAt });
  }

 
  async verifyAndRotate(userId: string, refreshToken: string): Promise<{ device: string }> {
    const candidates = await this.tokenModel.find({ userId: new Types.ObjectId(userId) }).exec();

    for (const doc of candidates) {
      if (doc.expiresAt.getTime() < Date.now()) continue;
      const isMatch = await bcrypt.compare(refreshToken, doc.tokenHash);
      if (isMatch) {
        const device = doc.device;
        // Only one concurrent refresh request may consume this single-use token.
        const consumed = await this.tokenModel.deleteOne({ _id: doc._id }).exec();
        if (consumed.deletedCount === 1) return { device };
        break;
      }
    }

    throw new UnauthorizedException('يرجى تسجيل الدخول مرة أخرى');
  }

  /** Logout: removes all sessions for this user (all devices). */
  async revokeAllForUser(userId: string) {
    await this.tokenModel.deleteMany({ userId: new Types.ObjectId(userId) }).exec();
  }
}
