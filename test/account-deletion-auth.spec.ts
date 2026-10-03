import { ForbiddenException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from '../src/auth/auth.service';
import { AccountStatus } from '../src/users/identity.types';
import { AuthErrorCode } from '../src/common/errors/auth-error-codes';
import { passwordFingerprint } from '../src/auth/token-types';

function createService() {
  const user: any = {
    _id: { toString: () => '64b000000000000000000002' },
    email: 'person@example.com',
    emailVerifiedAt: new Date(),
    accountStatus: AccountStatus.DELETION_PENDING,
    failedLoginAttempts: 0,
  };
  const users: any = {
    findByIdentifier: jest.fn().mockResolvedValue(user),
    findById: jest.fn().mockResolvedValue(user),
    save: jest.fn().mockResolvedValue(user),
    updatePasswordIfCurrent: jest.fn().mockResolvedValue(true),
  };
  const jwt: any = {
    verify: jest.fn().mockImplementation(() => ({
      sub: user._id.toString(),
      purpose: 'password_reset',
      typ: 'password_reset',
      pwf: passwordFingerprint('secret', user.password),
    })),
  };
  const config: any = { get: jest.fn().mockReturnValue('secret') };
  const otp: any = {
    assertCanResend: jest.fn().mockResolvedValue(undefined),
    generateAndStore: jest.fn().mockResolvedValue('123456'),
    verify: jest.fn().mockResolvedValue(undefined),
  };
  const mail: any = { sendOtp: jest.fn().mockResolvedValue(undefined) };
  const sms: any = {};
  const refresh: any = {
    rotate: jest.fn(),
    revokeAllForUser: jest.fn().mockResolvedValue(undefined),
  };
  const audit: any = { log: jest.fn().mockResolvedValue(undefined) };
  const deletion: any = {
    pendingLoginState: jest.fn().mockRejectedValue(new ForbiddenException({
      message: 'الحساب قيد الحذف',
      code: AuthErrorCode.ACCOUNT_DELETION_PENDING,
      deletion: { workflowVersion: 1 },
    })),
    validateRecoveryCredentials: jest.fn(),
    restoreAfterVerification: jest.fn(),
  };
  const service = new AuthService(users, jwt, config, otp, mail, sms, refresh, audit, deletion);
  return { service, user, users, otp, mail, refresh, deletion };
}

describe('MAZAD-017 authentication state integration', () => {
  it('valid credentials do not automatically restore a DELETION_PENDING account', async () => {
    const fixture = createService();
    fixture.user.password = await bcrypt.hash('Password123!', 4);

    const error = await fixture.service.login({
      identifier: 'person@example.com',
      password: 'Password123!',
      rememberMe: true,
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.getResponse()).toMatchObject({ code: AuthErrorCode.ACCOUNT_DELETION_PENDING });
    expect(fixture.deletion.pendingLoginState).toHaveBeenCalled();
  });

  it('forgot password remains available while deletion is pending', async () => {
    const fixture = createService();
    await expect(fixture.service.forgotPassword({ identifier: 'person@example.com' }))
      .resolves.toMatchObject({ expiresInMinutes: 5 });
    expect(fixture.otp.generateAndStore).toHaveBeenCalled();
    expect(fixture.mail.sendOtp).toHaveBeenCalled();
    expect(fixture.deletion.restoreAfterVerification).not.toHaveBeenCalled();
  });

  it('password reset changes the password but does not cancel deletion', async () => {
    const fixture = createService();
    fixture.user.password = await bcrypt.hash('OldPassword123!', 4);

    await expect(fixture.service.resetPassword({
      resetToken: 'reset-token',
      newPassword: 'NewPassword123!',
      confirmPassword: 'NewPassword123!',
    })).resolves.toMatchObject({ message: expect.any(String) });
    expect(fixture.users.updatePasswordIfCurrent).toHaveBeenCalled();
    expect(fixture.refresh.revokeAllForUser).toHaveBeenCalled();
    expect(fixture.deletion.restoreAfterVerification).not.toHaveBeenCalled();
    expect(fixture.user.accountStatus).toBe(AccountStatus.DELETION_PENDING);
  });

  it('keeps the email reserved while deletion is pending', async () => {
    const fixture = createService();

    await expect(fixture.service.register({
      fullName: 'Replacement Account',
      identifier: ' PERSON@EXAMPLE.COM ',
      phone: '+201012345678',
      password: 'Password123!',
      confirmPassword: 'Password123!',
    })).rejects.toMatchObject({ status: 409 });
    expect(fixture.users.findByIdentifier).toHaveBeenCalledWith('person@example.com');
    expect(fixture.users.create).toBeUndefined();
  });
});
