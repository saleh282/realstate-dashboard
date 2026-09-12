import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter;

  constructor(private config: ConfigService) {
    const host = this.config.get<string>('MAIL_HOST');
    const port = Number(this.config.get<string>('MAIL_PORT'));
    const user = this.config.get<string>('MAIL_USER');
    const pass = this.config.get<string>('MAIL_PASS');
    const secure = this.config.get<string>('MAIL_SECURE') === 'true';
    const rejectUnauthorized = this.config.get<string>('MAIL_TLS_REJECT_UNAUTHORIZED') !== 'false';

    this.transporter = host && port && user && pass ? nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user,
        pass,
      },
      tls: { rejectUnauthorized },
    }) : null;
  }

  async sendOtp(email: string, code: string) {
    if (!this.transporter) {
      throw new ServiceUnavailableException('خدمة البريد غير مهيأة حالياً');
    }

    try {
      const info = await this.transporter.sendMail({
        from: this.config.get('MAIL_FROM'),
        to: email,
        subject: 'رمز التحقق - منصة مزادات العقار',
        html: `<div dir="rtl" style="font-family: sans-serif; text-align: center;">
                 <h2>رمز التحقق الخاص بك</h2>
                 <p style="font-size: 32px; letter-spacing: 8px; font-weight: bold;">${code}</p>
                 <p>صالح لمدة 5 دقائق. لا تشارك هذا الرمز مع أي شخص.</p>
               </div>`,
      });
      this.logger.log(`OTP email accepted by SMTP${info?.messageId ? ` (messageId: ${info.messageId})` : ''}`);
    } catch {
      this.logger.error('SMTP rejected OTP email delivery');
      throw new ServiceUnavailableException('تعذر إرسال رسالة التحقق، حاول مرة أخرى لاحقاً');
    }
  }

  async sendTestEmail(email: string): Promise<void> {
    if (!this.transporter) throw new ServiceUnavailableException('خدمة البريد غير مهيأة حالياً');
    try {
      const info = await this.transporter.sendMail({
        from: this.config.get('MAIL_FROM'),
        to: email,
        subject: 'اختبار إعداد البريد - منصة مزادات العقار',
        text: 'نجح اتصال SMTP. لا تحتوي هذه الرسالة على رمز تحقق.',
      });
      this.logger.log(`SMTP test email accepted${info?.messageId ? ` (messageId: ${info.messageId})` : ''}`);
    } catch {
      this.logger.error('SMTP test email delivery failed');
      throw new ServiceUnavailableException('فشل اختبار إرسال البريد');
    }
  }
}
