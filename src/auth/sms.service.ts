import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

/**
 * Stub SMS sender. Since the identifier field accepts a Saudi phone number
 * (05xxxxxxxx), plug in a real provider here (Unifonic, Twilio, Msegat, etc).
 * Kept separate from MailService so swapping the provider doesn't touch auth logic.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  async sendOtp(_phone: string, _code: string): Promise<never> {
    this.logger.warn('Phone OTP requested, but no SMS provider is configured');
    throw new ServiceUnavailableException('إرسال رمز التحقق عبر الهاتف غير متاح حالياً');
  }
}
