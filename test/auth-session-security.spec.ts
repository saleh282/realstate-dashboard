import {
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { UserRole } from '../src/auth/roles.enum';
import { AccountStatus } from '../src/users/identity.types';

describe('active-account session enforcement', () => {
  const payload = {
    sub: '64b000000000000000000001',
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
      { get: jest.fn().mockReturnValue('test-access-secret') } as any,
      usersService as any,
      { isSessionActive: jest.fn().mockResolvedValue(true) } as any,
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
      { get: jest.fn().mockReturnValue('test-access-secret') } as any,
      usersService as any,
      { isSessionActive: jest.fn().mockResolvedValue(true) } as any,
    );

    await expect(strategy.validate(payload)).resolves.toMatchObject({
      userId: payload.sub,
      systemRole: UserRole.ADMIN,
    });
  });

  it('rejects refresh when the account was deleted', async () => {
    const service = Object.create(AuthService.prototype) as any;
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

    await expect(
      service.refresh('refresh-token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([AccountStatus.BLOCKED, AccountStatus.PERMANENTLY_BANNED])(
    'rejects refresh when the account is %s',
    async (accountStatus) => {
    const service = Object.create(AuthService.prototype) as any;
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

    await expect(
      service.refresh('refresh-token'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('allows a suspended account to rotate a valid refresh session', async () => {
    const service = Object.create(AuthService.prototype) as any;
    service.config = { get: jest.fn().mockReturnValue('7d') };
    service.jwtService = { sign: jest.fn().mockReturnValue('next-access') };
    service.refreshTokenService = {
      rotate: jest.fn().mockResolvedValue({
        userId: payload.sub,
        sessionId: 'session-id',
        refreshToken: 'next-refresh',
      }),
    };
    service.usersService = { findById: jest.fn().mockResolvedValue({
      _id: { toString: () => payload.sub },
      email: payload.identifier,
      emailVerifiedAt: new Date(),
      accountStatus: AccountStatus.SUSPENDED,
    }) };

    await expect(service.refresh('selector.secret')).resolves.toMatchObject({
      accessToken: 'next-access',
      refreshToken: 'next-refresh',
    });
  });

  it('revokes only the current session on logout and every session on logout-all', async () => {
    const service = Object.create(AuthService.prototype) as any;
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
    await service.logoutAll(payload.sub);
    expect(service.refreshTokenService.revokeAllForUser).toHaveBeenCalledWith(
      payload.sub,
      'LOGOUT_ALL',
    );
  });

  it('password reset revokes every existing session', async () => {
    const user = {
      _id: { toString: () => payload.sub },
      accountStatus: AccountStatus.ACTIVE,
    };
    const service = Object.create(AuthService.prototype) as any;
    service.config = { get: jest.fn().mockReturnValue('secret') };
    service.jwtService = {
      verify: jest.fn().mockReturnValue({ sub: payload.sub, purpose: 'password_reset' }),
    };
    service.usersService = {
      findById: jest.fn().mockResolvedValue(user),
      save: jest.fn(),
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
      { get: jest.fn().mockReturnValue('test-access-secret') } as any,
      { findById: jest.fn().mockResolvedValue({ accountStatus: AccountStatus.ACTIVE }) } as any,
      { isSessionActive: jest.fn().mockResolvedValue(false) } as any,
    );
    await expect(strategy.validate({ sub: payload.sub, sid: 'revoked' }))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([AccountStatus.BLOCKED, AccountStatus.PERMANENTLY_BANNED])(
    'rejects an existing access token when the account is %s',
    async (accountStatus) => {
      const strategy = new JwtStrategy(
        { get: jest.fn().mockReturnValue('test-access-secret') } as any,
        { findById: jest.fn().mockResolvedValue({ accountStatus }) } as any,
        { isSessionActive: jest.fn().mockResolvedValue(true) } as any,
      );

      await expect(strategy.validate(payload)).rejects.toBeInstanceOf(ForbiddenException);
    },
  );
});
