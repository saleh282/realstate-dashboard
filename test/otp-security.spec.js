'use strict';

const bcrypt = require('bcrypt');
const { OtpVerificationService } = require('../src/services/otp-verification.service');
const { OtpPurpose } = require('../src/models/otp-verification.model');
describe('OTP generation security', () => {
  it('creates a six-digit OTP without using Math.random and stores only its hash', async () => {
    const mathRandom = jest.spyOn(Math, 'random');
    const model = {
      updateMany: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    };
    const config = { get: jest.fn((key) => (key === 'OTP_EXPIRES_MINUTES' ? '5' : '60')) };
    const service = new OtpVerificationService(model, config);
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
