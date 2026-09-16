import { ServiceUnavailableException } from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service';
import { OtpPurpose } from '../src/auth/dto/password-reset.dto';
import { AuthErrorCode } from '../src/common/errors/auth-error-codes';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';

const phone = '+201012345678';

function createService() {
  const usersService = {
    findByIdentifier: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };
  const otpVerificationService = {
    assertCanResend: jest.fn(),
    generateAndStore: jest.fn(),
    verify: jest.fn(),
  };
  const mailService = { sendOtp: jest.fn() };
  const smsService = { sendOtp: jest.fn() };
  const service = new AuthService(
    usersService as any,
    {} as any,
    {} as any,
    otpVerificationService as any,
    mailService as any,
    smsService as any,
    {} as any,
    { log: jest.fn() } as any,
  );

  return {
    service,
    usersService,
    otpVerificationService,
    mailService,
    smsService,
  };
}

function expectPhoneAuthUnavailable(error: unknown) {
  expect(error).toBeInstanceOf(ServiceUnavailableException);
  expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
    code: AuthErrorCode.PHONE_AUTH_UNAVAILABLE,
  });
}

describe('V1 email-only authentication', () => {
  it('rejects phone registration before creating a user or OTP', async () => {
    const dependencies = createService();

    const error = await dependencies.service
      .register({
        fullName: 'Phone User',
        identifier: phone,
        password: 'Password123!',
        confirmPassword: 'Password123!',
      })
      .catch((caught) => caught);

    expectPhoneAuthUnavailable(error);
    expect(dependencies.usersService.findByIdentifier).not.toHaveBeenCalled();
    expect(dependencies.usersService.create).not.toHaveBeenCalled();
    expect(dependencies.otpVerificationService.generateAndStore).not.toHaveBeenCalled();
    expect(dependencies.smsService.sendOtp).not.toHaveBeenCalled();
  });

  it('rejects phone login before account lookup or mutation', async () => {
    const dependencies = createService();
    const error = await dependencies.service
      .login({ identifier: phone, password: 'Password123!' })
      .catch((caught) => caught);

    expectPhoneAuthUnavailable(error);
    expect(dependencies.usersService.findByIdentifier).not.toHaveBeenCalled();
    expect(dependencies.usersService.save).not.toHaveBeenCalled();
    expect(dependencies.smsService.sendOtp).not.toHaveBeenCalled();
  });

  it.each([
    [
      'OTP resend',
      (service: AuthService) =>
        service.resendOtp({ identifier: phone, purpose: OtpPurpose.REGISTER }),
    ],
    [
      'OTP verification',
      (service: AuthService) =>
        service.verifyOtp({
          identifier: phone,
          otp: '123456',
          purpose: OtpPurpose.REGISTER,
        }),
    ],
    [
      'forgot-password recovery',
      (service: AuthService) => service.forgotPassword({ identifier: phone }),
    ],
  ])('rejects phone %s before OTP/account access', async (_name, invoke) => {
    const dependencies = createService();
    const error = await invoke(dependencies.service).catch((caught) => caught);

    expectPhoneAuthUnavailable(error);
    expect(dependencies.usersService.findByIdentifier).not.toHaveBeenCalled();
    expect(dependencies.otpVerificationService.assertCanResend).not.toHaveBeenCalled();
    expect(dependencies.otpVerificationService.generateAndStore).not.toHaveBeenCalled();
    expect(dependencies.otpVerificationService.verify).not.toHaveBeenCalled();
    expect(dependencies.smsService.sendOtp).not.toHaveBeenCalled();
  });

  it('preserves the stable code in the existing error envelope', () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    };
    const exception = new ServiceUnavailableException({
      message: 'Phone authentication is unavailable',
      code: AuthErrorCode.PHONE_AUTH_UNAVAILABLE,
    });

    new HttpExceptionFilter().catch(exception, host as any);

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      success: false,
      message: 'Phone authentication is unavailable',
      code: AuthErrorCode.PHONE_AUTH_UNAVAILABLE,
      requestId: expect.any(String),
    });
  });

  it('does not mutate a legacy phone-only record when phone auth is rejected', async () => {
    const dependencies = createService();
    dependencies.usersService.findByIdentifier.mockResolvedValue({
      phone,
      phoneVerifiedAt: new Date(),
    });

    await expect(
      dependencies.service.forgotPassword({ identifier: phone }),
    ).rejects.toMatchObject({ status: 503 });
    expect(dependencies.usersService.findByIdentifier).not.toHaveBeenCalled();
    expect(dependencies.usersService.save).not.toHaveBeenCalled();
  });

  it.each([
    [
      'forgot-password',
      (service: AuthService) =>
        service.forgotPassword({ identifier: 'person@example.com' }),
      'password_reset',
    ],
    [
      'OTP resend',
      (service: AuthService) =>
        service.resendOtp({
          identifier: 'person@example.com',
          purpose: OtpPurpose.REGISTER,
        }),
      'register',
    ],
  ])('keeps email %s delivery functional', async (_name, invoke, purpose) => {
    const dependencies = createService();
    dependencies.usersService.findByIdentifier.mockResolvedValue({
      email: 'person@example.com',
      emailVerifiedAt: purpose === 'password_reset' ? new Date() : undefined,
    });
    dependencies.otpVerificationService.generateAndStore.mockResolvedValue(
      '123456',
    );

    await expect(invoke(dependencies.service)).resolves.toBeDefined();
    expect(
      dependencies.otpVerificationService.generateAndStore,
    ).toHaveBeenCalledWith('person@example.com', purpose);
    expect(dependencies.mailService.sendOtp).toHaveBeenCalledWith(
      'person@example.com',
      '123456',
    );
    expect(dependencies.smsService.sendOtp).not.toHaveBeenCalled();
  });
});
