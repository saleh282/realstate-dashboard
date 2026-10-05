'use strict';

const { ServiceUnavailableException } = require('../src/common/http/errors');
const { ConfigService } = require('../src/config/config');
const { MailService } = require('../src/services/mail.service');
describe('MailService', () => {
  const config = new ConfigService({
    MAIL_HOST: 'smtp.example.test',
    MAIL_PORT: '587',
    MAIL_SECURE: 'false',
    MAIL_USER: 'user',
    MAIL_PASS: 'password',
    MAIL_FROM: 'noreply@example.test',
    MAIL_TLS_REJECT_UNAUTHORIZED: 'true',
  });
  it('propagates OTP delivery failures as a controlled service error', async () => {
    const service = new MailService(config);
    service.transporter = {
      sendMail: jest.fn().mockRejectedValue(new Error('SMTP credentials rejected')),
    };
    await expect(service.sendOtp('person@example.com', '123456')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
  it('does not claim delivery when SMTP is not configured', async () => {
    const service = new MailService(new ConfigService({}));
    await expect(service.sendOtp('person@example.com', '123456')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
