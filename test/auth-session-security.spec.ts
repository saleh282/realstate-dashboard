import {
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { UserRole } from '../src/auth/roles.enum';

describe('active-account session enforcement', () => {
  const payload = {
    sub: '64b000000000000000000001',
    identifier: 'person@example.com',
  };

  it('rejects an existing access token when the account is suspended', async () => {
    const usersService = {
      findById: jest.fn().mockResolvedValue({
        isActive: false,
        role: UserRole.USER,
      }),
    };
    const strategy = new JwtStrategy(
      { get: jest.fn().mockReturnValue('test-access-secret') } as any,
      usersService as any,
    );

    await expect(strategy.validate(payload)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('uses the current database role for an active access token', async () => {
    const usersService = {
      findById: jest.fn().mockResolvedValue({
        isActive: true,
        role: UserRole.ADMIN,
      }),
    };
    const strategy = new JwtStrategy(
      { get: jest.fn().mockReturnValue('test-access-secret') } as any,
      usersService as any,
    );

    await expect(strategy.validate(payload)).resolves.toMatchObject({
      userId: payload.sub,
      role: UserRole.ADMIN,
    });
  });

  it('rejects refresh when the account was deleted', async () => {
    const service = Object.create(AuthService.prototype) as any;
    service.refreshTokenService = {
      verifyAndRotate: jest.fn().mockResolvedValue({ device: 'test' }),
    };
    service.usersService = { findById: jest.fn().mockResolvedValue(null) };

    await expect(
      service.refresh(payload.sub, 'refresh-token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects refresh when the account is suspended', async () => {
    const service = Object.create(AuthService.prototype) as any;
    service.refreshTokenService = {
      verifyAndRotate: jest.fn().mockResolvedValue({ device: 'test' }),
    };
    service.usersService = {
      findById: jest.fn().mockResolvedValue({ isActive: false }),
    };

    await expect(
      service.refresh(payload.sub, 'refresh-token'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
