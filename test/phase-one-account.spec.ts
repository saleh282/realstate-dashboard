import { validate } from 'class-validator';
import * as bcrypt from 'bcrypt';
import { RegisterDto } from '../src/auth/dto/register.dto';
import {
  identifierLookupValues,
  normalizeIdentifier,
} from '../src/common/validators/identifier.validator';
import { UsersService } from '../src/users/users.service';
import { AuditAction } from '../src/audit/schemas/audit-log.schema';

describe('Phase 1 account contracts', () => {
  it.each([
    ['01012345678', '+201012345678'],
    ['201012345678', '+201012345678'],
    ['00201012345678', '+201012345678'],
    ['0501234567', '+966501234567'],
    ['USER@Example.COM', 'user@example.com'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeIdentifier(input)?.value).toBe(expected);
  });

  it('keeps lookup compatibility with pre-normalization Egyptian phones', () => {
    expect(identifierLookupValues('+201012345678')).toEqual(
      expect.arrayContaining(['+201012345678', '01012345678']),
    );
  });

  it('uses the shared identifier policy in registration DTO validation', async () => {
    const valid = Object.assign(new RegisterDto(), {
      fullName: 'Test User',
      identifier: '01012345678',
      phone: '+201012345678',
      password: 'password',
      confirmPassword: 'password',
      acceptedTermsVersion: 1,
      acceptedPrivacyVersion: 1,
    });
    const invalid = Object.assign(new RegisterDto(), {
      ...valid,
      identifier: '1234567',
    });

    expect(await validate(valid)).toHaveLength(0);
    expect(await validate(invalid)).not.toHaveLength(0);
  });

  it('updates only the editable profile name and writes an audit event', async () => {
    const user = { fullName: 'Old Name' };
    const service = Object.create(UsersService.prototype) as any;
    service.findById = jest.fn().mockResolvedValue(user);
    service.save = jest.fn().mockResolvedValue(user);
    service.getProfile = jest.fn().mockResolvedValue({
      userId: 'user-id',
      fullName: 'New Name',
    });
    service.auditLogService = { log: jest.fn().mockResolvedValue(undefined) };

    await expect(
      service.updateProfile('user-id', '  New Name  ', '127.0.0.1'),
    ).resolves.toMatchObject({ fullName: 'New Name' });
    expect(user.fullName).toBe('New Name');
    expect(service.auditLogService.log).toHaveBeenCalledWith(
      AuditAction.PROFILE_UPDATED,
      'user-id',
      '127.0.0.1',
    );
  });

  it('changes password with bcrypt and revokes every refresh session', async () => {
    const oldHash = await bcrypt.hash('old-password', 4);
    const user: any = {
      password: oldHash,
      failedLoginAttempts: 2,
      accountLockedUntil: new Date(),
    };
    const service = Object.create(UsersService.prototype) as any;
    service.findById = jest.fn().mockResolvedValue(user);
    service.save = jest.fn().mockResolvedValue(user);
    service.refreshTokenService = {
      revokeAllForUser: jest.fn().mockResolvedValue(undefined),
    };
    service.auditLogService = { log: jest.fn().mockResolvedValue(undefined) };

    await service.changePassword(
      'user-id',
      'old-password',
      'new-password',
      '127.0.0.1',
    );

    await expect(bcrypt.compare('new-password', user.password)).resolves.toBe(true);
    expect(service.refreshTokenService.revokeAllForUser).toHaveBeenCalledWith('user-id');
    expect(user.failedLoginAttempts).toBe(0);
    expect(user.accountLockedUntil).toBeUndefined();
  });
});
