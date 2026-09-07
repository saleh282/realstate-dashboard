import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter;

  constructor(private config: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.config.get('MAIL_HOST'),
      port: Number(this.config.get('MAIL_PORT')),
      secure: false,
      auth: {
        user: this.config.get('MAIL_USER'),
        pass: this.config.get('MAIL_PASS'),
      },
      // بعض الشبكات المحلية أو برامج الأنتي فايروس بتعمل SSL inspection
      // وبتحط شهادة self-signed بتخلي Node يرفض الاتصال بالغلط.
      // ⚠️ ده تجاوز مؤقت للتطوير المحلي بس على جهازك — لازم يتشال قبل رفع
      // المشروع على أي سيرفر حقيقي (production).
      tls: { rejectUnauthorized: false },
    });
  }

  async sendOtp(email: string, code: string) {
    try {
      await this.transporter.sendMail({
        from: this.config.get('MAIL_FROM'),
        to: email,
        subject: 'رمز التحقق - منصة مزادات العقار',
        html: `<div dir="rtl" style="font-family: sans-serif; text-align: center;">
                 <h2>رمز التحقق الخاص بك</h2>
                 <p style="font-size: 32px; letter-spacing: 8px; font-weight: bold;">${code}</p>
                 <p>صالح لمدة 5 دقائق. لا تشارك هذا الرمز مع أي شخص.</p>
               </div>`,
      });
    } catch (err) {
      // Don't leak SMTP errors to the client; log for ops instead
      this.logger.error(`Failed to send OTP email to ${email}: ${err.message}`);
    }
  }
}