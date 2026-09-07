import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import {
  OtpVerification,
  OtpVerificationDocument,
  OtpPurpose,
} from './schemas/otp-verification.schema';

@Injectable()
export class OtpVerificationService {
  constructor(
    @InjectModel(OtpVerification.name) private otpModel: Model<OtpVerificationDocument>,
    private config: ConfigService,
  ) {}

  private get expiresMinutes() {
    return Number(this.config.get('OTP_EXPIRES_MINUTES') ?? 5);
  }

  private get resendSeconds() {
    return Number(this.config.get('OTP_RESEND_SECONDS') ?? 60);
  }

  private generateCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  /** Checks the resend cooldown (matches the "00:56 إعادة الإرسال بعد" countdown on the OTP screen) */
  async assertCanResend(identifier: string, purpose: OtpPurpose) {
    const last = await this.otpModel
      .findOne({ identifier, purpose })
      .sort({ createdAt: -1 })
      .exec();

    if (last) {
      const secondsSince = (Date.now() - (last as any).createdAt.getTime()) / 1000;
      if (secondsSince < this.resendSeconds) {
        const wait = Math.ceil(this.resendSeconds - secondsSince);
        throw new BadRequestException(`يرجى الانتظار ${wait} ثانية قبل إعادة الإرسال`);
      }
    }
  }

  /** Generates a new OTP, invalidates any older unused ones for the same identifier+purpose,
   *  and stores only the hash. Returns the plain code so the caller can email/sms it. */
  async generateAndStore(identifier: string, purpose: OtpPurpose): Promise<string> {
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

    console.log(`🔑 OTP: ${code}`);  
    return code;
  }

 
  async verify(identifier: string, code: string, purpose: OtpPurpose): Promise<void> {
    const otpDoc = await this.otpModel
      .findOne({ identifier, purpose, isUsed: false })
      .sort({ createdAt: -1 })
      .exec();

    if (!otpDoc) {
      throw new BadRequestException('لم يتم إرسال رمز تحقق، يرجى طلب رمز جديد');
    }
    if (otpDoc.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('انتهت صلاحية رمز التحقق، يرجى طلب رمز جديد');
    }
    if (otpDoc.attempts >= 5) {
      throw new BadRequestException('تم تجاوز عدد المحاولات المسموح بها، يرجى طلب رمز جديد');
    }

    const isMatch = await bcrypt.compare(code, otpDoc.otpHash);
    if (!isMatch) {
      otpDoc.attempts += 1;
      await otpDoc.save();
      throw new BadRequestException('رمز التحقق غير صحيح');
    }

    otpDoc.isUsed = true;
    await otpDoc.save();
  }
}
