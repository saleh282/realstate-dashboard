import { Injectable, Logger } from '@nestjs/common';

/**
 * Stub SMS sender. Since the identifier field accepts a Saudi phone number
 * (05xxxxxxxx), plug in a real provider here (Unifonic, Twilio, Msegat, etc).
 * Kept separate from MailService so swapping the provider doesn't touch auth logic.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  async sendOtp(phone: string, code: string) {
    // TODO: integrate real SMS provider
    this.logger.log(`[SMS STUB] OTP ${code} would be sent to ${phone}`);
  }
}
