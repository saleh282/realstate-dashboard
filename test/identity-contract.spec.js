'use strict';

const { ForbiddenException, ServiceUnavailableException } = require('../src/common/http/errors');
const { ValidationPipe } = require('../src/middleware/validate');
const bcrypt = require('bcrypt');
const { AuthService } = require('../src/services/auth.service');
const { RegisterDto } = require('../src/validators/auth/register.dto');
const { OtpPurpose } = require('../src/validators/auth/password-reset.dto');
const { JwtStrategy } = require('../src/services/access-token.service');
const { SystemRole } = require('../src/domain/auth/roles.enum');
const { AuthErrorCode } = require('../src/common/errors/auth-error-codes');
const {
  applyUserIdentityMigration,
  isIdentityMigrationApplyMode,
  planUserIdentityMigration,
} = require('../src/migrations/007-user-identity-contract');
const {
  AccountStatus,
  AccountType,
  BrokerStatus,
  PrimaryIdentifierType,
  VerificationTrustState,
  identityProjection,
  isIdentifierVerified,
} = require('../src/domain/users/identity.types');
describe('MAZAD-007 identity contract', () => {
  it('rejects public registration attempts to self-assign privileged identity fields', async () => {
    const pipe = new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    });
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
  it('records email verification without changing phone verification', async () => {
    const identifier = 'channel@example.com';
    const user = {
      _id: { toString: () => '64b000000000000000000001' },
      email: identifier,
      accountStatus: AccountStatus.ACTIVE,
    };
    const users = {
      findByIdentifier: jest.fn().mockResolvedValue(user),
      save: jest.fn().mockImplementation(async (value) => value),
    };
    const service = new AuthService(
      users,
      {},
      {},
      { verify: jest.fn().mockResolvedValue(undefined) },
      {},
      {},
      { log: jest.fn() },
    );
    await service.verifyOtp({ identifier, otp: '123456', purpose: OtpPurpose.REGISTER });
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(user.phoneVerifiedAt).toBeUndefined();
  });
  it('preserves legacy phone verification data but rejects phone OTP auth', async () => {
    const service = Object.create(AuthService.prototype);
    await expect(
      service.verifyOtp({
        identifier: '+201001234567',
        otp: '123456',
        purpose: OtpPurpose.REGISTER,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
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
        users,
        { sign: jest.fn().mockReturnValueOnce('access').mockReturnValueOnce('refresh') },
        { get: jest.fn((key) => (key.includes('EXPIRES') ? '15m' : 'secret')) },
        {},
        {},
        {
          createSession: jest.fn().mockResolvedValue({
            refreshToken: 'refresh',
            sessionId: 'session-id',
          }),
        },
        { log: jest.fn().mockResolvedValue(undefined) },
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
      { findByIdentifier: jest.fn().mockResolvedValue(user) },
      {},
      {},
      {},
      {},
      { revokeAllForUser: jest.fn() },
      { log: jest.fn().mockResolvedValue(undefined) },
    );
    const error = await service
      .login({ identifier: user.email, password, rememberMe: true })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.getResponse()).toMatchObject({ code });
  });
  it('uses current database identity instead of stale JWT claims', async () => {
    const strategy = new JwtStrategy(
      { get: jest.fn().mockReturnValue('secret') },
      {
        findById: jest.fn().mockResolvedValue({
          systemRole: SystemRole.USER,
          accountStatus: AccountStatus.ACTIVE,
        }),
      },
      { isSessionActive: jest.fn().mockResolvedValue(true) },
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
    expect(() => planUserIdentityMigration({ _id: '4', email: 'a@b.com', role: 'owner' })).toThrow(
      'Unsupported legacy role',
    );
    expect(() =>
      planUserIdentityMigration({
        _id: '5',
        email: 'a@b.com',
        systemRole: SystemRole.USER,
      }),
    ).toThrow('automatic overwrite is forbidden');
  });
  it('is resumable and idempotent when the apply step is repeated', async () => {
    const documents = [
      {
        _id: '6',
        email: 'resume@example.com',
        role: 'user',
        isActive: true,
        emailVerified: true,
        kycStatus: 'pending',
      },
    ];
    const matchesUnmigrated = (document) =>
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
      updateOne: jest.fn(async (filter, update) => {
        const document = documents.find(
          (candidate) => candidate._id === filter._id && matchesUnmigrated(candidate),
        );
        if (!document) return { modifiedCount: 0 };
        Object.assign(document, update.$set);
        return { modifiedCount: 1 };
      }),
    };
    await expect(applyUserIdentityMigration(collection, 'run-1')).resolves.toBe(1);
    await expect(applyUserIdentityMigration(collection, 'run-2')).resolves.toBe(0);
    expect(documents[0]).toMatchObject({
      systemRole: SystemRole.USER,
      accountType: AccountType.USER,
      primaryIdentifierType: PrimaryIdentifierType.EMAIL,
      identityMigrationRunId: 'run-1',
    });
  });
});
