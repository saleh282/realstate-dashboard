'use strict';

const { ForbiddenException, UnauthorizedException } = require('../src/common/http/errors');
const { AuthService } = require('../src/services/auth.service');
const { JwtStrategy } = require('../src/services/access-token.service');
const { passwordFingerprint } = require('../src/domain/auth/token-types');
const { UserRole } = require('../src/domain/auth/roles.enum');
const { AccountStatus } = require('../src/domain/users/identity.types');
describe('active-account session enforcement', () => {
  const payload = {
    sub: '64b000000000000000000001',
    sid: 'session-id',
    identifier: 'person@example.com',
  };
  it('allows an existing access token when the account is suspended', async () => {
    const usersService = {
      findById: jest.fn().mockResolvedValue({
        accountStatus: AccountStatus.SUSPENDED,
        systemRole: UserRole.USER,
      }),
    };
    const strategy = new JwtStrategy(
      { get: jest.fn().mockReturnValue('test-access-secret') },
      usersService,
      { isSessionActive: jest.fn().mockResolvedValue(true) },
    );
    await expect(strategy.validate(payload)).resolves.toMatchObject({
      accountStatus: AccountStatus.SUSPENDED,
    });
  });
  it('uses the current database role for an active access token', async () => {
    const usersService = {
      findById: jest.fn().mockResolvedValue({
        accountStatus: AccountStatus.ACTIVE,
        systemRole: UserRole.ADMIN,
      }),
    };
    const strategy = new JwtStrategy(
      { get: jest.fn().mockReturnValue('test-access-secret') },
      usersService,
      { isSessionActive: jest.fn().mockResolvedValue(true) },
    );
    await expect(strategy.validate(payload)).resolves.toMatchObject({
      userId: payload.sub,
      systemRole: UserRole.ADMIN,
    });
  });
  it('rejects refresh when the account was deleted', async () => {
    const service = Object.create(AuthService.prototype);
    service.config = { get: jest.fn().mockReturnValue('7d') };
    service.refreshTokenService = {
      rotate: jest.fn().mockResolvedValue({
        userId: payload.sub,
        sessionId: 'session-id',
        refreshToken: 'next-refresh',
      }),
      revokeSession: jest.fn(),
    };
    service.usersService = { findById: jest.fn().mockResolvedValue(null) };
    await expect(service.refresh('refresh-token')).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it.each([
    AccountStatus.BLOCKED,
    AccountStatus.PERMANENTLY_BANNED,
    AccountStatus.DELETION_PENDING,
    AccountStatus.ANONYMIZED,
  ])('rejects refresh when the account is %s', async (accountStatus) => {
    const service = Object.create(AuthService.prototype);
    service.config = { get: jest.fn().mockReturnValue('7d') };
    service.refreshTokenService = {
      rotate: jest.fn().mockResolvedValue({
        userId: payload.sub,
        sessionId: 'session-id',
        refreshToken: 'next-refresh',
      }),
      revokeAllForUser: jest.fn().mockResolvedValue(undefined),
    };
    service.usersService = {
      findById: jest.fn().mockResolvedValue({ accountStatus }),
    };
    await expect(service.refresh('refresh-token')).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('allows a suspended account to rotate a valid refresh session', async () => {
    const service = Object.create(AuthService.prototype);
    service.config = { get: jest.fn().mockReturnValue('7d') };
    service.jwtService = { sign: jest.fn().mockReturnValue('next-access') };
    service.refreshTokenService = {
      rotate: jest.fn().mockResolvedValue({
        userId: payload.sub,
        sessionId: 'session-id',
        refreshToken: 'next-refresh',
      }),
    };
    service.usersService = {
      findById: jest.fn().mockResolvedValue({
        _id: { toString: () => payload.sub },
        email: payload.identifier,
        emailVerifiedAt: new Date(),
        accountStatus: AccountStatus.SUSPENDED,
      }),
    };
    await expect(service.refresh('selector.secret')).resolves.toMatchObject({
      accessToken: 'next-access',
      refreshToken: 'next-refresh',
    });
  });
  it('revokes only the current session on logout', async () => {
    const service = Object.create(AuthService.prototype);
    service.refreshTokenService = {
      revokeSession: jest.fn(),
      revokeAllForUser: jest.fn(),
    };
    service.auditLogService = { log: jest.fn() };
    await service.logout(payload.sub, 'current-session');
    expect(service.refreshTokenService.revokeSession).toHaveBeenCalledWith(
      payload.sub,
      'current-session',
      'LOGOUT',
    );
  });
  it('password reset revokes every existing session', async () => {
    const user = {
      _id: { toString: () => payload.sub },
      accountStatus: AccountStatus.ACTIVE,
      password: 'stored-password-hash',
    };
    const service = Object.create(AuthService.prototype);
    service.config = { get: jest.fn().mockReturnValue('secret') };
    service.jwtService = {
      verify: jest.fn().mockReturnValue({
        sub: payload.sub,
        purpose: 'password_reset',
        typ: 'password_reset',
        pwf: passwordFingerprint('secret', user.password),
      }),
    };
    service.usersService = {
      findById: jest.fn().mockResolvedValue(user),
      updatePasswordIfCurrent: jest.fn().mockResolvedValue(true),
    };
    service.refreshTokenService = { revokeAllForUser: jest.fn() };
    service.auditLogService = { log: jest.fn() };
    await service.resetPassword({
      resetToken: 'reset-token',
      newPassword: 'NewPassword1!',
      confirmPassword: 'NewPassword1!',
    });
    expect(service.refreshTokenService.revokeAllForUser).toHaveBeenCalledWith(payload.sub);
  });
  it('rejects an access token whose server-side session was revoked', async () => {
    const strategy = new JwtStrategy(
      { get: jest.fn().mockReturnValue('test-access-secret') },
      { findById: jest.fn().mockResolvedValue({ accountStatus: AccountStatus.ACTIVE }) },
      { isSessionActive: jest.fn().mockResolvedValue(false) },
    );
    await expect(strategy.validate({ sub: payload.sub, sid: 'revoked' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
  it.each([AccountStatus.BLOCKED, AccountStatus.PERMANENTLY_BANNED])(
    'rejects an existing access token when the account is %s',
    async (accountStatus) => {
      const strategy = new JwtStrategy(
        { get: jest.fn().mockReturnValue('test-access-secret') },
        { findById: jest.fn().mockResolvedValue({ accountStatus }) },
        { isSessionActive: jest.fn().mockResolvedValue(true) },
      );
      await expect(strategy.validate(payload)).rejects.toBeInstanceOf(ForbiddenException);
    },
  );
});
