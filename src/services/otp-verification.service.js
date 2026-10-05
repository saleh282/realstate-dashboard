'use strict';

const { BadRequestException } = require('../common/http/errors');
const bcrypt = require('bcrypt');
const { randomInt } = require('crypto');
const { AuthErrorCode } = require('../common/errors/auth-error-codes');
class OtpVerificationService {
  constructor(otpModel, config) {
    this.otpModel = otpModel;
    this.config = config;
  }
  get expiresMinutes() {
    return Number(this.config.get('OTP_EXPIRES_MINUTES') ?? 5);
  }
  get resendSeconds() {
    return Number(this.config.get('OTP_RESEND_SECONDS') ?? 60);
  }
  generateCode() {
    return randomInt(100000, 1000000).toString();
  }
  /** Checks the resend cooldown (matches the "00:56 إعادة الإرسال بعد" countdown on the OTP screen) */
  async assertCanResend(identifier, purpose) {
    const last = await this.otpModel
      .findOne({ identifier, purpose })
      .sort({ createdAt: -1 })
      .exec();
    if (last) {
      const secondsSince = (Date.now() - last.createdAt.getTime()) / 1000;
      if (secondsSince < this.resendSeconds) {
        const wait = Math.ceil(this.resendSeconds - secondsSince);
        throw new BadRequestException({
          message: `يرجى الانتظار ${wait} ثانية قبل إعادة الإرسال`,
          code: AuthErrorCode.OTP_RESEND_TOO_SOON,
          retryAfterSeconds: wait,
        });
      }
    }
  }
  /** Generates a new OTP, invalidates any older unused ones for the same identifier+purpose,
   *  and stores only the hash. Returns the plain code so the caller can email/sms it. */
  async generateAndStore(identifier, purpose) {
    const code = this.generateCode();
    const otpHash = await bcrypt.hash(code, 10);
    // invalidate any older still-usable OTPs for the same identifier+purpose
    await this.otpModel.updateMany(
      { identifier, purpose, isUsed: false },
      { $set: { isUsed: true } },
    );
    await this.otpModel.create({
      identifier,
      otpHash,
      purpose,
      attempts: 0,
      isUsed: false,
      expiresAt: new Date(Date.now() + this.expiresMinutes * 60 * 1000),
    });
    return code;
  }
  async verify(identifier, code, purpose) {
    const otpDoc = await this.otpModel
      .findOne({ identifier, purpose, isUsed: false })
      .sort({ createdAt: -1 })
      .exec();
    if (!otpDoc) {
      throw new BadRequestException({
        message: 'لم يتم إرسال رمز تحقق، يرجى طلب رمز جديد',
        code: AuthErrorCode.OTP_NOT_REQUESTED,
      });
    }
    if (otpDoc.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException({
        message: 'انتهت صلاحية رمز التحقق، يرجى طلب رمز جديد',
        code: AuthErrorCode.OTP_EXPIRED,
      });
    }
    if (otpDoc.attempts >= 5) {
      throw new BadRequestException({
        message: 'تم تجاوز عدد المحاولات المسموح بها، يرجى طلب رمز جديد',
        code: AuthErrorCode.OTP_ATTEMPTS_EXCEEDED,
      });
    }
    const isMatch = await bcrypt.compare(code, otpDoc.otpHash);
    if (!isMatch) {
      otpDoc.attempts += 1;
      await otpDoc.save();
      throw new BadRequestException({
        message: 'رمز التحقق غير صحيح',
        code: AuthErrorCode.OTP_INVALID,
      });
    }
    otpDoc.isUsed = true;
    await otpDoc.save();
  }
}

Object.assign(exports, { OtpVerificationService });
