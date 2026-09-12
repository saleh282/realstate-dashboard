import * as bcrypt from 'bcrypt';
import { ConfigService } from '@nestjs/config';
import { OtpVerificationService } from '../src/otp/otp-verification.service';
import { OtpPurpose } from '../src/otp/schemas/otp-verification.schema';

describe('OTP generation security', () => {
  it('creates a six-digit OTP without using Math.random and stores only its hash', async () => {
    const mathRandom = jest.spyOn(Math, 'random');
    const model = {
      updateMany: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    };
    const config = { get: jest.fn((key: string) => (key === 'OTP_EXPIRES_MINUTES' ? '5' : '60')) };
    const service = new OtpVerificationService(model as any, config as unknown as ConfigService);

    const code = await service.generateAndStore('person@example.com', OtpPurpose.REGISTER);

    expect(code).toMatch(/^\d{6}$/);
    expect(mathRandom).not.toHaveBeenCalled();
    expect(model.create).toHaveBeenCalledTimes(1);
    const stored = model.create.mock.calls[0][0];
    expect(stored).not.toHaveProperty('otp');
    expect(stored.otpHash).not.toBe(code);
    await expect(bcrypt.compare(code, stored.otpHash)).resolves.toBe(true);
    mathRandom.mockRestore();
  });
});
