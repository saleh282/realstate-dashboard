import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { randomBytes, randomUUID } from 'crypto';
import {
  RefreshToken,
  RefreshTokenDocument,
  RefreshTokenState,
} from './schemas/refresh-token.schema';
import { AuthErrorCode } from '../common/errors/auth-error-codes';

type SessionToken = {
  refreshToken: string;
  sessionId: string;
  userId: string;
  device: string;
};

@Injectable()
export class RefreshTokenService {
  constructor(
    @InjectModel(RefreshToken.name) private tokenModel: Model<RefreshTokenDocument>,
  ) {}

  private invalid(code = AuthErrorCode.INVALID_REFRESH_TOKEN) {
    return new UnauthorizedException({
      message: 'يرجى تسجيل الدخول مرة أخرى',
      code,
    });
  }

  private generateToken() {
    const selector = randomBytes(18).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    return { selector, secret, token: `${selector}.${secret}` };
  }

  private parseToken(token: string) {
    const match =
      typeof token === 'string'
        ? /^([A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{43})$/.exec(token)
        : null;
    return match ? { selector: match[1], secret: match[2] } : null;
  }

  async createSession(
    userId: string,
    expiresAt: Date,
    device = 'unknown',
  ): Promise<SessionToken> {
    const sessionId = randomUUID();
    const familyId = randomUUID();
    const generated = this.generateToken();
    await this.tokenModel.create({
      userId: new Types.ObjectId(userId),
      sessionId,
      familyId,
      selector: generated.selector,
      tokenHash: await bcrypt.hash(generated.secret, 10),
      state: RefreshTokenState.ACTIVE,
      device: device.slice(0, 200),
      expiresAt,
    });
    return { refreshToken: generated.token, sessionId, userId, device };
  }

  async rotate(
    refreshToken: string,
    expiresAt: Date,
    device?: string,
    legacyUserId?: string,
  ): Promise<SessionToken> {
    const parsed = this.parseToken(refreshToken);
    if (!parsed) {
      if (!legacyUserId) throw this.invalid();
      return this.rotateLegacy(legacyUserId, refreshToken, expiresAt, device);
    }

    const existing = await this.tokenModel.findOne({ selector: parsed.selector }).exec();
    if (!existing || !existing.familyId || !existing.sessionId) throw this.invalid();
    if (existing.state !== RefreshTokenState.ACTIVE) {
      if (existing.state === RefreshTokenState.ROTATED) {
        await this.revokeFamily(existing.familyId, 'REFRESH_TOKEN_REUSE');
        throw this.invalid(AuthErrorCode.REFRESH_TOKEN_REUSED);
      }
      throw this.invalid(AuthErrorCode.SESSION_REVOKED);
    }
    if (existing.expiresAt.getTime() <= Date.now()) {
      throw this.invalid(AuthErrorCode.SESSION_EXPIRED);
    }
    if (!(await bcrypt.compare(parsed.secret, existing.tokenHash))) throw this.invalid();

    const now = new Date();
    const consumed = await this.tokenModel.findOneAndUpdate(
      { _id: existing._id, state: RefreshTokenState.ACTIVE },
      { $set: { state: RefreshTokenState.ROTATED, rotatedAt: now, lastUsedAt: now } },
      { new: true },
    ).exec();
    if (!consumed) {
      await this.revokeFamily(existing.familyId, 'CONCURRENT_REFRESH_REUSE');
      throw this.invalid(AuthErrorCode.REFRESH_TOKEN_REUSED);
    }

    const generated = this.generateToken();
    const nextDevice = (device ?? existing.device ?? 'unknown').slice(0, 200);
    try {
      await this.tokenModel.create({
        userId: existing.userId,
        sessionId: existing.sessionId,
        familyId: existing.familyId,
        selector: generated.selector,
        tokenHash: await bcrypt.hash(generated.secret, 10),
        state: RefreshTokenState.ACTIVE,
        device: nextDevice,
        expiresAt: existing.expiresAt,
      });
    } catch (error) {
      await this.revokeFamily(existing.familyId, 'ROTATION_WRITE_FAILED');
      throw error;
    }
    // Close the race where a concurrent replay marks the family compromised
    // immediately before this replacement row is inserted.
    const familyGuard = await this.tokenModel.findOne({ _id: existing._id }).exec();
    if (familyGuard?.state === RefreshTokenState.REVOKED) {
      await this.revokeFamily(existing.familyId, 'CONCURRENT_REFRESH_REUSE');
      throw this.invalid(AuthErrorCode.REFRESH_TOKEN_REUSED);
    }
    return {
      refreshToken: generated.token,
      sessionId: existing.sessionId,
      userId: existing.userId.toString(),
      device: nextDevice,
    };
  }

  private async rotateLegacy(
    userId: string,
    refreshToken: string,
    expiresAt: Date,
    device?: string,
  ): Promise<SessionToken> {
    const candidates = await this.tokenModel.find({
      userId: new Types.ObjectId(userId),
      selector: { $exists: false },
    }).exec();

    for (const doc of candidates) {
      if (doc.expiresAt.getTime() <= Date.now()) continue;
      const isMatch = await bcrypt.compare(refreshToken, doc.tokenHash);
      if (isMatch) {
        const consumed = await this.tokenModel.deleteOne({ _id: doc._id }).exec();
        if (consumed.deletedCount !== 1) {
          throw this.invalid(AuthErrorCode.REFRESH_TOKEN_REUSED);
        }
        return this.createSession(userId, expiresAt, device ?? doc.device);
      }
    }
    throw this.invalid();
  }

  async isSessionActive(userId: string, sessionId: string): Promise<boolean> {
    return Boolean(await this.tokenModel.exists({
      userId: new Types.ObjectId(userId),
      sessionId,
      state: { $in: [RefreshTokenState.ACTIVE, RefreshTokenState.ROTATED] },
      expiresAt: { $gt: new Date() },
    }));
  }

  async revokeSession(userId: string, sessionId: string, reason = 'LOGOUT') {
    await this.tokenModel.updateMany(
      {
        userId: new Types.ObjectId(userId),
        sessionId,
        state: { $in: [RefreshTokenState.ACTIVE, RefreshTokenState.ROTATED] },
      },
      { $set: { state: RefreshTokenState.REVOKED, revokedAt: new Date(), revokeReason: reason } },
    ).exec();
  }

  async revokeFamily(familyId: string, reason: string) {
    await this.tokenModel.updateMany(
      { familyId },
      { $set: { state: RefreshTokenState.REVOKED, revokedAt: new Date(), revokeReason: reason } },
    ).exec();
  }

  async revokeAllForUser(userId: string, reason = 'ACCOUNT_SESSIONS_REVOKED') {
    await this.tokenModel.updateMany(
      {
        userId: new Types.ObjectId(userId),
        state: { $in: [RefreshTokenState.ACTIVE, RefreshTokenState.ROTATED] },
      },
      { $set: { state: RefreshTokenState.REVOKED, revokedAt: new Date(), revokeReason: reason } },
    ).exec();
    await this.tokenModel.deleteMany({
      userId: new Types.ObjectId(userId),
      selector: { $exists: false },
    }).exec();
  }
}
