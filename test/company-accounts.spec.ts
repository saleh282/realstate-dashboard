import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ValidationPipe,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Types } from 'mongoose';
import { CompanyAccountsService } from '../src/admin/company-accounts.service';
import { CreateCompanyAccountDto } from '../src/admin/dto/create-company-account.dto';
import { AuditAction } from '../src/audit/schemas/audit-log.schema';
import { AuthService } from '../src/auth/auth.service';
import { SystemRole } from '../src/auth/roles.enum';
import { CompanyErrorCode } from '../src/common/errors/company-error-codes';
import { UpdateProfileDto } from '../src/users/dto/update-profile.dto';
import { UsersService } from '../src/users/users.service';
import {
  AccountStatus,
  AccountType,
  BrokerStatus,
  PrimaryIdentifierType,
  VerificationTrustState,
} from '../src/users/identity.types';
import { KycStatus } from '../src/users/schemas/user.schema';

const actorUserId = '64b000000000000000000001';
const companyUserId = new Types.ObjectId('64b000000000000000000002');
const initialPassword = 'CompanyPass123!';

function query<T>(value: T) {
  const chain: any = {
    select: jest.fn(() => chain),
    lean: jest.fn(() => chain),
    exec: jest.fn().mockResolvedValue(value),
  };
  return chain;
}

function companyDocument(overrides: Record<string, unknown> = {}) {
  return {
    _id: companyUserId,
    fullName: 'Mazad Company',
    email: 'company@example.com',
    phone: '+201001234567',
    systemRole: SystemRole.USER,
    accountType: AccountType.COMPANY,
    accountStatus: AccountStatus.ACTIVE,
    brokerStatus: BrokerStatus.NOT_APPLIED,
    brokerVersion: 0,
    verificationTrustState: VerificationTrustState.UNVERIFIED,
    primaryIdentifierType: PrimaryIdentifierType.EMAIL,
    emailVerifiedAt: new Date('2026-09-17T12:00:00.000Z'),
    role: 'user',
    emailVerified: true,
    isActive: true,
    kycStatus: KycStatus.NOT_SUBMITTED,
    kycVersion: 0,
    createdAt: new Date('2026-09-17T12:00:00.000Z'),
    updatedAt: new Date('2026-09-17T12:00:00.000Z'),
    ...overrides,
  };
}

function setup(existing: Record<string, unknown> | null = null) {
  const createdRows: any[] = [];
  const userModel: any = {
    findOne: jest.fn(() => query(existing)),
    create: jest.fn(async (rows: any[]) => {
      createdRows.push(...rows);
      return rows.map((row) => companyDocument(row));
    }),
  };
  const connection = {
    transaction: jest.fn(async (callback: (session: object) => unknown) => callback({ id: 'session' })),
  };
  const audit = { logRequired: jest.fn().mockResolvedValue(undefined) };
  const service = new CompanyAccountsService(userModel, connection as any, audit as any);
  return { service, userModel, connection, audit, createdRows };
}

const dto: CreateCompanyAccountDto = {
  fullName: '  Mazad Company  ',
  email: 'COMPANY@EXAMPLE.COM',
  phone: '01001234567',
  initialPassword,
};

describe('MAZAD-013 Admin-created COMPANY accounts', () => {
  it('creates one User-compatible COMPANY account and audits only safe identity state', async () => {
    const harness = setup();

    const result = await harness.service.create(dto, {
      actorUserId,
      requestId: 'request-013',
      ip: '127.0.0.1',
    });

    expect(result.account).toMatchObject({
      userId: companyUserId.toString(),
      fullName: 'Mazad Company',
      email: 'company@example.com',
      phone: '+201001234567',
      systemRole: SystemRole.USER,
      accountType: AccountType.COMPANY,
      accountStatus: AccountStatus.ACTIVE,
      brokerStatus: BrokerStatus.NOT_APPLIED,
      verificationTrustState: VerificationTrustState.UNVERIFIED,
    });
    expect(result).not.toHaveProperty('password');
    expect(result.account).not.toHaveProperty('password');

    const stored = harness.createdRows[0];
    expect(stored.password).not.toBe(initialPassword);
    await expect(bcrypt.compare(initialPassword, stored.password)).resolves.toBe(true);
    expect(stored).toMatchObject({
      systemRole: SystemRole.USER,
      accountType: AccountType.COMPANY,
      accountStatus: AccountStatus.ACTIVE,
      brokerStatus: BrokerStatus.NOT_APPLIED,
      primaryIdentifierType: PrimaryIdentifierType.EMAIL,
    });

    expect(harness.audit.logRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.ADMIN_COMPANY_ACCOUNT_CREATED,
        actorUserId,
        targetUserId: companyUserId.toString(),
        metadata: {
          requestId: 'request-013',
          after: {
            systemRole: SystemRole.USER,
            accountType: AccountType.COMPANY,
            accountStatus: AccountStatus.ACTIVE,
            brokerStatus: BrokerStatus.NOT_APPLIED,
          },
        },
      }),
      expect.anything(),
    );
    expect(JSON.stringify(harness.audit.logRequired.mock.calls)).not.toContain(initialPassword);
    expect(JSON.stringify(result)).not.toContain(initialPassword);
  });

  it('rejects an existing email with a stable conflict code before hashing or creating', async () => {
    const harness = setup({ email: 'company@example.com' });
    const error = await harness.service
      .create(dto, { actorUserId, requestId: 'duplicate-email' })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ code: CompanyErrorCode.EMAIL_ALREADY_EXISTS });
    expect(harness.userModel.create).not.toHaveBeenCalled();
    expect(harness.audit.logRequired).not.toHaveBeenCalled();
  });

  it('rejects an invalid initial password with a stable payload code', async () => {
    const harness = setup();
    const error = await harness.service
      .create(
        { ...dto, initialPassword: 'short' },
        { actorUserId, requestId: 'invalid-password' },
      )
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse()).toMatchObject({
      code: CompanyErrorCode.PAYLOAD_INVALID,
      details: { fields: ['initialPassword'] },
    });
    expect(harness.userModel.findOne).not.toHaveBeenCalled();
  });

  it('rejects client-supplied identity/status fields with a stable privilege code', async () => {
    const harness = setup();
    const error = await harness.service
      .create(
        { ...dto, accountType: AccountType.USER, systemRole: SystemRole.ADMIN },
        { actorUserId, requestId: 'privileged-assignment' },
      )
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse()).toMatchObject({
      code: CompanyErrorCode.PRIVILEGED_ASSIGNMENT_FORBIDDEN,
      details: { fields: ['systemRole', 'accountType'] },
    });
    expect(harness.userModel.findOne).not.toHaveBeenCalled();
  });

  it('keeps public profile updates from assigning COMPANY or any privileged identity field', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
    await expect(
      pipe.transform(
        { fullName: 'Updated Name', accountType: AccountType.COMPANY },
        { type: 'body', metatype: UpdateProfileDto },
      ),
    ).rejects.toBeDefined();
  });

  it('keeps public registration fixed to USER/USER even if a COMPANY field is attempted', async () => {
    const users = {
      findByIdentifier: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async (value) => ({
        ...value,
        _id: { toString: () => companyUserId.toString() },
      })),
    };
    const auth = new AuthService(
      users as any,
      {} as any,
      {} as any,
      { generateAndStore: jest.fn().mockResolvedValue('123456') } as any,
      { sendOtp: jest.fn().mockResolvedValue(undefined) } as any,
      { sendOtp: jest.fn() } as any,
      {} as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
    );

    await auth.register({
      fullName: 'Public User',
      identifier: 'public@example.com',
      phone: '+201012345678',
      password: initialPassword,
      confirmPassword: initialPassword,
      acceptedTermsVersion: 1,
      acceptedPrivacyVersion: 1,
    });

    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({
        systemRole: SystemRole.USER,
        accountType: AccountType.USER,
        brokerStatus: BrokerStatus.NOT_APPLIED,
      }),
    );
  });

  it.each([AccountStatus.ACTIVE, AccountStatus.SUSPENDED])(
    'allows a %s COMPANY account to authenticate through the common session flow',
    async (accountStatus) => {
      const password = await bcrypt.hash(initialPassword, 4);
      const user = companyDocument({ password, accountStatus, failedLoginAttempts: 0 });
      const auth = new AuthService(
        {
          findByIdentifier: jest.fn().mockResolvedValue(user),
          save: jest.fn().mockResolvedValue(user),
        } as any,
        { sign: jest.fn().mockReturnValue('access-token') } as any,
        { get: jest.fn((key: string) => key.includes('EXPIRES') ? '15m' : 'secret') } as any,
        {} as any,
        {} as any,
        {} as any,
        {
          createSession: jest.fn().mockResolvedValue({
            sessionId: 'company-session',
            refreshToken: 'company-refresh',
          }),
        } as any,
        { log: jest.fn().mockResolvedValue(undefined) } as any,
      );

      await expect(
        auth.login({ identifier: user.email, password: initialPassword, rememberMe: true }),
      ).resolves.toMatchObject({
        user: { accountType: AccountType.COMPANY, accountStatus },
      });
    },
  );

  it.each([AccountStatus.BLOCKED, AccountStatus.PERMANENTLY_BANNED])(
    'denies a %s COMPANY account through the common auth source of truth',
    async (accountStatus) => {
      const password = await bcrypt.hash(initialPassword, 4);
      const user = companyDocument({ password, accountStatus, failedLoginAttempts: 0 });
      const auth = new AuthService(
        { findByIdentifier: jest.fn().mockResolvedValue(user) } as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        { revokeAllForUser: jest.fn() } as any,
        { log: jest.fn().mockResolvedValue(undefined) } as any,
      );

      await expect(
        auth.login({ identifier: user.email, password: initialPassword, rememberMe: true }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('uses the normal password-change flow and revokes every COMPANY session', async () => {
    const user: any = companyDocument({
      password: await bcrypt.hash(initialPassword, 4),
      failedLoginAttempts: 2,
      accountLockedUntil: new Date(),
    });
    const users = Object.create(UsersService.prototype) as any;
    users.findById = jest.fn().mockResolvedValue(user);
    users.save = jest.fn().mockResolvedValue(user);
    users.refreshTokenService = { revokeAllForUser: jest.fn().mockResolvedValue(undefined) };
    users.auditLogService = { log: jest.fn().mockResolvedValue(undefined) };

    await users.changePassword(
      companyUserId.toString(),
      initialPassword,
      'UpdatedCompanyPass123!',
      '127.0.0.1',
    );

    await expect(bcrypt.compare('UpdatedCompanyPass123!', user.password)).resolves.toBe(true);
    expect(users.refreshTokenService.revokeAllForUser).toHaveBeenCalledWith(
      companyUserId.toString(),
    );
    expect(users.auditLogService.log).toHaveBeenCalledWith(
      AuditAction.PASSWORD_CHANGED,
      companyUserId.toString(),
      '127.0.0.1',
    );
  });
});
