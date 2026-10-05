'use strict';

const { ConflictException } = require('../src/common/http/errors');
const { AuthService } = require('../src/services/auth.service');
const { HttpExceptionFilter } = require('../src/middleware/error-handler');
const registration = {
  fullName: 'Test User',
  identifier: 'person@example.com',
  phone: '+201012345678',
  password: 'password',
  confirmPassword: 'password',
  acceptedTermsVersion: 1,
  acceptedPrivacyVersion: 1,
};
function createAuthService(existing) {
  const usersService = {
    findByIdentifier: jest
      .fn()
      .mockResolvedValue(
        existing ? { _id: { toString: () => 'existing-user-id' }, ...existing } : null,
      ),
    replaceUnverifiedRegistration: jest.fn().mockResolvedValue(true),
    create: jest.fn().mockResolvedValue({
      _id: { toString: () => 'new-user-id' },
      emailVerified: false,
    }),
  };
  const otpVerificationService = {
    generateAndStore: jest.fn().mockResolvedValue('123456'),
    assertCanResend: jest.fn().mockResolvedValue(undefined),
  };
  const refreshTokenService = { revokeAllForUser: jest.fn().mockResolvedValue(undefined) };
  const mailService = { sendOtp: jest.fn().mockResolvedValue(undefined) };
  const smsService = { sendOtp: jest.fn() };
  const auditLogService = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new AuthService(
    usersService,
    {},
    {},
    otpVerificationService,
    mailService,
    refreshTokenService,
    auditLogService,
  );
  return { service, otpVerificationService, mailService };
}
describe('registration verification response', () => {
  it('returns isVerified=false and sends OTP for a new account', async () => {
    const { service, mailService } = createAuthService();
    await expect(service.register(registration)).resolves.toMatchObject({
      identifier: registration.identifier,
      isVerified: false,
      requiresVerification: true,
      otpSent: true,
    });
    expect(mailService.sendOtp).toHaveBeenCalledWith(registration.identifier, '123456');
    expect(service.usersService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        systemRole: 'USER',
        accountType: 'USER',
        accountStatus: 'ACTIVE',
        brokerStatus: 'NOT_APPLIED',
        verificationTrustState: 'UNVERIFIED',
        primaryIdentifierType: 'email',
      }),
    );
  });
  it('resends OTP and returns a structured conflict for an existing unverified account', async () => {
    const { service, otpVerificationService, mailService } = createAuthService({
      emailVerified: false,
      email: registration.identifier,
    });
    const error = await service.register(registration).catch((caught) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({
      isVerified: false,
      requiresVerification: true,
      otpSent: true,
      identifier: registration.identifier,
    });
    expect(otpVerificationService.generateAndStore).toHaveBeenCalled();
    expect(mailService.sendOtp).toHaveBeenCalledWith(registration.identifier, '123456');
  });
  it('does not send OTP for an existing verified account', async () => {
    const { service, otpVerificationService, mailService } = createAuthService({
      emailVerified: true,
      email: registration.identifier,
    });
    const error = await service.register(registration).catch((caught) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({
      isVerified: true,
      requiresVerification: false,
      otpSent: false,
    });
    expect(otpVerificationService.generateAndStore).not.toHaveBeenCalled();
    expect(mailService.sendOtp).not.toHaveBeenCalled();
  });
  it('preserves verification metadata in the HTTP error response', () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
      }),
    };
    const exception = new ConflictException({
      message: 'الحساب غير مفعل',
      isVerified: false,
      requiresVerification: true,
      otpSent: true,
      identifier: registration.identifier,
      expiresInMinutes: 5,
    });
    new HttpExceptionFilter().handle(
      exception,
      host.switchToHttp().getRequest?.(),
      host.switchToHttp().getResponse(),
    );
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        isVerified: false,
        requiresVerification: true,
        otpSent: true,
      }),
    );
  });
});
