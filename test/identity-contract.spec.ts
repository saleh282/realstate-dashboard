import { ForbiddenException, ValidationPipe } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from '../src/auth/auth.service';
import { RegisterDto } from '../src/auth/dto/register.dto';
import { OtpPurpose } from '../src/auth/dto/password-reset.dto';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { SystemRole } from '../src/auth/roles.enum';
import { AuthErrorCode } from '../src/common/errors/auth-error-codes';
import {
  applyUserIdentityMigration,
  isIdentityMigrationApplyMode,
  planUserIdentityMigration,
} from '../src/migrations/007-user-identity-contract';
import {
  AccountStatus,
  AccountType,
  BrokerStatus,
  PrimaryIdentifierType,
  VerificationTrustState,
  identityProjection,
  isIdentifierVerified,
} from '../src/users/identity.types';

describe('MAZAD-007 identity contract', () => {
  it('rejects public registration attempts to self-assign privileged identity fields', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
    await expect(
      pipe.transform(
        {
          fullName: 'Identity User',
          identifier: 'identity@example.com',
          password: 'ValidPassword1!',
          confirmPassword: 'ValidPassword1!',
          systemRole: SystemRole.SUPER_ADMIN,
          accountType: AccountType.COMPANY,
        },
        { type: 'body', metatype: RegisterDto },
      ),
    ).rejects.toBeDefined();
  });

  it('projects safe defaults and read-only legacy aliases', () => {
    expect(identityProjection({ email: 'new@example.com' })).toMatchObject({
      systemRole: SystemRole.USER,
      accountType: AccountType.USER,
      accountStatus: AccountStatus.ACTIVE,
      brokerStatus: BrokerStatus.NOT_APPLIED,
      verificationTrustState: VerificationTrustState.UNVERIFIED,
      role: 'user',
      isActive: true,
      emailVerified: false,
    });
  });

  it('keeps email and phone verification independent', () => {
    const phoneOnly = {
      phone: '+201001234567',
      phoneVerifiedAt: new Date(),
      primaryIdentifierType: PrimaryIdentifierType.PHONE,
    };
    expect(isIdentifierVerified(phoneOnly, '+201001234567')).toBe(true);
    expect(isIdentifierVerified(phoneOnly, 'other@example.com')).toBe(false);
  });

  it.each([
    ['channel@example.com', 'emailVerifiedAt', 'phoneVerifiedAt'],
    ['+201001234567', 'phoneVerifiedAt', 'emailVerifiedAt'],
  ])('records verification only for the exact %s channel', async (identifier, setField, unsetField) => {
    const user: Record<string, any> = {
      _id: { toString: () => '64b000000000000000000001' },
      email: identifier.includes('@') ? identifier : undefined,
      phone: identifier.includes('@') ? undefined : identifier,
      accountStatus: AccountStatus.ACTIVE,
    };
    const users = {
      findByIdentifier: jest.fn().mockResolvedValue(user),
      save: jest.fn().mockImplementation(async (value) => value),
    };
    const service = new AuthService(
      users as any,
      {} as any,
      {} as any,
      { verify: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      {} as any,
      {} as any,
      { log: jest.fn() } as any,
    );

    await service.verifyOtp({ identifier, otp: '123456', purpose: OtpPurpose.REGISTER });
    expect(user[setField]).toBeInstanceOf(Date);
    expect(user[unsetField]).toBeUndefined();
  });

  it.each([AccountStatus.ACTIVE, AccountStatus.SUSPENDED])(
    'allows %s users to authenticate',
    async (accountStatus) => {
      const password = 'ValidPassword1!';
      const user = {
        _id: { toString: () => '64b000000000000000000001' },
        fullName: 'Identity User',
        email: 'identity@example.com',
        password: await bcrypt.hash(password, 4),
        emailVerifiedAt: new Date(),
        systemRole: SystemRole.USER,
        accountType: AccountType.USER,
        accountStatus,
        brokerStatus: BrokerStatus.NOT_APPLIED,
        verificationTrustState: VerificationTrustState.UNVERIFIED,
        primaryIdentifierType: PrimaryIdentifierType.EMAIL,
        kycStatus: 'not_submitted',
        failedLoginAttempts: 0,
      };
      const users = {
        findByIdentifier: jest.fn().mockResolvedValue(user),
        save: jest.fn().mockResolvedValue(user),
      };
      const service = new AuthService(
        users as any,
        { sign: jest.fn().mockReturnValueOnce('access').mockReturnValueOnce('refresh') } as any,
        { get: jest.fn((key: string) => key.includes('EXPIRES') ? '15m' : 'secret') } as any,
        {} as any,
        {} as any,
        {} as any,
        {
          createSession: jest.fn().mockResolvedValue({
            refreshToken: 'refresh',
            sessionId: 'session-id',
          }),
        } as any,
        { log: jest.fn().mockResolvedValue(undefined) } as any,
      );

      await expect(
        service.login({ identifier: user.email, password, rememberMe: true }),
      ).resolves.toMatchObject({ user: { accountStatus } });
    },
  );

  it.each([
    [AccountStatus.BLOCKED, AuthErrorCode.ACCOUNT_BLOCKED],
    [AccountStatus.PERMANENTLY_BANNED, AuthErrorCode.ACCOUNT_PERMANENTLY_BANNED],
  ])('denies %s users with stable code %s', async (accountStatus, code) => {
    const password = 'ValidPassword1!';
    const user = {
      _id: { toString: () => '64b000000000000000000001' },
      email: 'identity@example.com',
      password: await bcrypt.hash(password, 4),
      emailVerifiedAt: new Date(),
      accountStatus,
      failedLoginAttempts: 0,
    };
    const service = new AuthService(
      { findByIdentifier: jest.fn().mockResolvedValue(user) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { revokeAllForUser: jest.fn() } as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
    );
    const error = await service
      .login({ identifier: user.email, password, rememberMe: true })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.getResponse()).toMatchObject({ code });
  });

  it('uses current database identity instead of stale JWT claims', async () => {
    const strategy = new JwtStrategy(
      { get: jest.fn().mockReturnValue('secret') } as any,
      {
        findById: jest.fn().mockResolvedValue({
          systemRole: SystemRole.USER,
          accountStatus: AccountStatus.ACTIVE,
        }),
      } as any,
      { isSessionActive: jest.fn().mockResolvedValue(true) } as any,
    );
    await expect(
      strategy.validate({
        sub: '64b000000000000000000001',
        sid: 'session-id',
      }),
    ).resolves.toMatchObject({ systemRole: SystemRole.USER });
  });
});

describe('MAZAD-007 migration planning', () => {
  it('defaults to dry-run and requires an explicit --apply flag', () => {
    expect(isIdentityMigrationApplyMode(['node', 'migration.ts'])).toBe(false);
    expect(isIdentityMigrationApplyMode(['node', 'migration.ts', '--apply'])).toBe(true);
  });
  it('maps legacy admin/suspended/KYC data without deleting legacy fields', () => {
    expect(
      planUserIdentityMigration({
        _id: '1',
        email: 'admin@example.com',
        role: 'admin',
        isActive: false,
        emailVerified: true,
        kycStatus: 'verified',
      }),
    ).toEqual({
      systemRole: SystemRole.ADMIN,
      accountType: AccountType.USER,
      accountStatus: AccountStatus.SUSPENDED,
      brokerStatus: BrokerStatus.NOT_APPLIED,
      verificationTrustState: VerificationTrustState.VERIFIED,
      primaryIdentifierType: PrimaryIdentifierType.EMAIL,
      legacyVerifiedIdentifierType: PrimaryIdentifierType.EMAIL,
    });
  });

  it('does not fabricate SUPER_ADMIN or verified KYC trust', () => {
    expect(
      planUserIdentityMigration({
        _id: '2',
        phone: '+201001234567',
        role: 'user',
        isActive: true,
        emailVerified: false,
        kycStatus: 'pending',
      }),
    ).toMatchObject({
      systemRole: SystemRole.USER,
      verificationTrustState: VerificationTrustState.UNVERIFIED,
      primaryIdentifierType: PrimaryIdentifierType.PHONE,
    });
  });

  it('blocks ambiguous, malformed, and partially migrated rows', () => {
    expect(() =>
      planUserIdentityMigration({ _id: '3', email: 'a@b.com', phone: '+201001234567' }),
    ).toThrow('Exactly one');
    expect(() =>
      planUserIdentityMigration({ _id: '4', email: 'a@b.com', role: 'owner' }),
    ).toThrow('Unsupported legacy role');
    expect(() =>
      planUserIdentityMigration({
        _id: '5',
        email: 'a@b.com',
        systemRole: SystemRole.USER,
      }),
    ).toThrow('automatic overwrite is forbidden');
  });

  it('is resumable and idempotent when the apply step is repeated', async () => {
    const documents: Array<Record<string, any>> = [
      {
        _id: '6',
        email: 'resume@example.com',
        role: 'user',
        isActive: true,
        emailVerified: true,
        kycStatus: 'pending',
      },
    ];
    const matchesUnmigrated = (document: Record<string, any>) =>
      [
        'systemRole',
        'accountType',
        'accountStatus',
        'brokerStatus',
        'verificationTrustState',
        'primaryIdentifierType',
      ].every((field) => document[field] === undefined);
    const collection = {
      find: jest.fn(() => ({
        async *[Symbol.asyncIterator]() {
          for (const document of documents.filter(matchesUnmigrated)) yield document;
        },
      })),
      updateOne: jest.fn(async (filter: Record<string, any>, update: Record<string, any>) => {
        const document = documents.find(
          (candidate) => candidate._id === filter._id && matchesUnmigrated(candidate),
        );
        if (!document) return { modifiedCount: 0 };
        Object.assign(document, update.$set);
        return { modifiedCount: 1 };
      }),
    };

    await expect(applyUserIdentityMigration(collection as any, 'run-1')).resolves.toBe(1);
    await expect(applyUserIdentityMigration(collection as any, 'run-2')).resolves.toBe(0);
    expect(documents[0]).toMatchObject({
      systemRole: SystemRole.USER,
      accountType: AccountType.USER,
      primaryIdentifierType: PrimaryIdentifierType.EMAIL,
      identityMigrationRunId: 'run-1',
    });
  });
});
