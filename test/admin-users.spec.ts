import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '../src/auth/roles.enum';
import { SystemRole } from '../src/auth/roles.enum';
import { AccountStatus } from '../src/users/identity.types';
import { UsersService } from '../src/users/users.service';
import { AuditAction } from '../src/audit/schemas/audit-log.schema';

const actorUserId = '64b000000000000000000001';
const targetUserId = '64b000000000000000000002';

function createService() {
  const userModel: Record<string, any> = {
  };
  const refreshTokenService = {
    revokeAllForUser: jest.fn().mockResolvedValue(undefined),
  };
  const auditLogService = {
    log: jest.fn(),
    logAdminAction: jest.fn().mockResolvedValue(undefined),
    logRequired: jest.fn().mockResolvedValue(undefined),
  };
  const sessions: any[] = [];
  const connection = {
    startSession: jest.fn().mockImplementation(async () => {
      const session = { withTransaction: jest.fn(async (work: () => Promise<void>) => work()), endSession: jest.fn() };
      sessions.push(session);
      return session;
    }),
  };
  const outbox = { recordRequired: jest.fn().mockResolvedValue(undefined) };
  const service = new UsersService(
    userModel as any,
    refreshTokenService as any,
    auditLogService as any,
    connection as any,
    outbox as any,
  );

  return {
    service,
    userModel,
    refreshTokenService,
    auditLogService,
    connection,
    outbox,
    sessions,
  };
}

describe('admin user status management', () => {
  it('prevents self-suspension', async () => {
    const { service } = createService();
    await expect(
      service.updateStatusForAdmin({
        actorUserId,
        actorSystemRole: SystemRole.ADMIN,
        targetUserId: actorUserId,
        accountStatus: AccountStatus.SUSPENDED,
        reason: 'Suspension test',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('prevents suspending another administrator', async () => {
    const { service } = createService();
    jest.spyOn(service, 'findById').mockResolvedValue({
      role: UserRole.ADMIN,
      email: 'admin2@example.com',
    } as any);

    await expect(
      service.updateStatusForAdmin({
        actorUserId,
        actorSystemRole: SystemRole.ADMIN,
        targetUserId,
        accountStatus: AccountStatus.SUSPENDED,
        reason: 'Suspension test',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks user, revokes their sessions, and logs action', async () => {
    const { service, refreshTokenService, auditLogService } = createService();
    const mockUser = {
      role: UserRole.USER,
      isActive: true,
      save: jest.fn().mockResolvedValue(true),
    };
    jest.spyOn(service, 'findById').mockResolvedValue(mockUser as any);
    jest.spyOn(service, 'save').mockImplementation(async (u: any) => u);

    const result = await service.updateStatusForAdmin({
      actorUserId,
      actorSystemRole: SystemRole.ADMIN,
      targetUserId,
      accountStatus: AccountStatus.BLOCKED,
      reason: 'Violation of terms',
      ip: '127.0.0.1',
    });

    expect(result.accountStatus).toBe(AccountStatus.BLOCKED);
    expect(refreshTokenService.revokeAllForUser).toHaveBeenCalledWith(targetUserId);
    expect(auditLogService.logAdminAction).toHaveBeenCalledWith(
      AuditAction.ADMIN_USER_STATUS_UPDATED,
      actorUserId,
      targetUserId,
      'Violation of terms',
      '127.0.0.1',
      {
        before: { accountStatus: AccountStatus.ACTIVE },
        after: { accountStatus: AccountStatus.BLOCKED },
      },
    );
  });
});

describe('admin session revocation and role update', () => {
  it('revokes all user sessions and logs audit', async () => {
    const { service, refreshTokenService, auditLogService } = createService();
    jest.spyOn(service, 'findById').mockResolvedValue({ role: UserRole.USER } as any);

    await service.revokeSessionsForAdmin({
      actorUserId,
      actorSystemRole: SystemRole.ADMIN,
      targetUserId,
      reason: 'Security breach suspected',
    });

    expect(refreshTokenService.revokeAllForUser).toHaveBeenCalledWith(targetUserId);
    expect(auditLogService.logAdminAction).toHaveBeenCalledWith(
      AuditAction.ADMIN_USER_SESSIONS_REVOKED,
      actorUserId,
      targetUserId,
      'Security breach suspected',
      undefined,
    );
  });

  it('prevents an ADMIN from revoking another ADMIN sessions', async () => {
    const { service, refreshTokenService } = createService();
    jest.spyOn(service, 'findById').mockResolvedValue({ systemRole: SystemRole.ADMIN } as any);

    await expect(
      service.revokeSessionsForAdmin({
        actorUserId,
        actorSystemRole: SystemRole.ADMIN,
        targetUserId,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(refreshTokenService.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('prevents product session control over SUPER_ADMIN', async () => {
    const { service, refreshTokenService } = createService();
    jest.spyOn(service, 'findById').mockResolvedValue({ systemRole: SystemRole.SUPER_ADMIN } as any);

    await expect(
      service.revokeSessionsForAdmin({
        actorUserId,
        actorSystemRole: SystemRole.SUPER_ADMIN,
        targetUserId,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(refreshTokenService.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('prevents changing own role', async () => {
    const { service } = createService();
    await expect(
      service.updateRoleForAdmin({
        actorUserId,
        actorSystemRole: SystemRole.SUPER_ADMIN,
        targetUserId: actorUserId,
        systemRole: SystemRole.USER,
        reason: 'Role demotion test',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('updates role and revokes tokens so user re-authenticates', async () => {
    const { service, refreshTokenService, auditLogService } = createService();
    const mockUser = {
      role: UserRole.USER,
      save: jest.fn().mockResolvedValue(true),
    };
    jest.spyOn(service, 'findById').mockResolvedValue(mockUser as any);
    jest.spyOn(service, 'save').mockImplementation(async (u: any) => u);

    const result = await service.updateRoleForAdmin({
      actorUserId,
      actorSystemRole: SystemRole.SUPER_ADMIN,
      targetUserId,
      systemRole: SystemRole.ADMIN,
      reason: 'Promoted to support admin',
    });

    expect(result.systemRole).toBe(SystemRole.ADMIN);
    expect(refreshTokenService.revokeAllForUser).toHaveBeenCalledWith(targetUserId);
    expect(auditLogService.logAdminAction).toHaveBeenCalledWith(
      AuditAction.ADMIN_USER_ROLE_UPDATED,
      actorUserId,
      targetUserId,
      'Promoted to support admin',
      undefined,
      {
        before: { systemRole: SystemRole.USER },
        after: { systemRole: SystemRole.ADMIN },
      },
    );
  });
});

describe('admin KYC document metadata', () => {
  it('does not expose legacy KYC URLs in the account profile', async () => {
    const { service, userModel } = createService();
    userModel.findById = jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        _id: { toString: () => targetUserId },
        fullName: 'Test User',
        email: 'user@example.com',
        kycStatus: 'pending',
        idFrontUrl: 'https://provider.example/private-front',
        idBackUrl: 'https://provider.example/private-back',
        selfieUrl: 'https://provider.example/private-selfie',
        idFrontAsset: { publicId: 'front' },
        idBackAsset: { publicId: 'back' },
        selfieAsset: { publicId: 'selfie' },
      }),
    });

    const result = await service.getProfile(targetUserId);
    expect(result.hasKycEvidence).toBe(true);
    expect(result).not.toHaveProperty('idFrontUrl');
    expect(result).not.toHaveProperty('idBackUrl');
    expect(result).not.toHaveProperty('selfieUrl');
  });

  it('returns availability flags instead of direct Cloudinary URLs', async () => {
    const { service } = createService();
    jest.spyOn(service, 'findById').mockResolvedValue({
      _id: { toString: () => targetUserId },
      fullName: 'Test User',
      kycStatus: 'pending',
      idFrontUrl: 'https://cloudinary.example/direct-front',
      idFrontAsset: { publicId: 'front' },
      idBackAsset: { publicId: 'back' },
      selfieAsset: { publicId: 'selfie' },
    } as any);

    const result = await service.getKycDetailsForAdmin(targetUserId);

    expect(result).toMatchObject({
      hasIdFront: true,
      hasIdBack: true,
      hasSelfie: true,
    });
    expect(result).not.toHaveProperty('idFrontUrl');
    expect(result).not.toHaveProperty('idBackUrl');
    expect(result).not.toHaveProperty('selfieUrl');
  });

  it('selects only the requested stored asset', async () => {
    const { service } = createService();
    const idBackAsset = { publicId: 'back' };
    jest.spyOn(service, 'findById').mockResolvedValue({ idBackAsset } as any);

    await expect(
      service.getKycAssetForAdmin(targetUserId, 'id-back'),
    ).resolves.toMatchObject({
      ...idBackAsset,
      resourceType: 'image',
      deliveryType: 'authenticated',
      classification: 'private_kyc_evidence',
    });
  });
});

describe('admin KYC review state machine', () => {
  function mockConditionalUpdate(
    userModel: Record<string, jest.Mock>,
    result: Record<string, unknown> | null,
    current?: Record<string, unknown> | null,
  ) {
    userModel.findOneAndUpdate = jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(result),
    });
    userModel.findById = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        session: jest.fn().mockReturnValue({ lean: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(current) }) }),
      }),
    });
  }

  it.each([
    ['verified', undefined, 'verified'],
    ['rejected', 'Identity photo is unreadable', 'rejected'],
  ] as const)('atomically transitions pending to %s and audits before/after', async (
    decision,
    rejectionReason,
    expectedStatus,
  ) => {
    const { service, userModel, auditLogService, outbox } = createService();
    mockConditionalUpdate(userModel, {
      kycStatus: expectedStatus,
      kycVersion: 4,
      kycReviewedAt: new Date('2026-09-15T08:00:00.000Z'),
    });

    const result = await service.reviewKycForAdmin({
      actorUserId,
      targetUserId,
      decision,
      rejectionReason,
      expectedVersion: 3,
      ip: '127.0.0.1',
    });

    expect(result).toMatchObject({
      kycStatus: expectedStatus,
      kycVersion: 4,
    });
    expect(userModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        kycStatus: 'pending',
        kycVersion: 3,
      }),
      expect.objectContaining({ $inc: { kycVersion: 1 } }),
      expect.objectContaining({ new: true, runValidators: true, session: expect.anything() }),
    );
    expect(auditLogService.logRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.ADMIN_KYC_REVIEWED,
        actorUserId,
        targetUserId,
        metadata: expect.objectContaining({
          before: { kycStatus: 'pending', kycVersion: 3 },
          after: expect.objectContaining({ kycStatus: expectedStatus, kycVersion: 4 }),
        }),
      }),
      expect.anything(),
    );
    expect(outbox.recordRequired).toHaveBeenCalledWith(expect.objectContaining({
      type: decision === 'verified' ? 'KYC_APPROVED' : 'KYC_REJECTED',
      privateRouting: { subjectAccountId: targetUserId },
    }), expect.anything());
  });

  it('requires a meaningful rejection reason before writing', async () => {
    const { service, userModel } = createService();

    await expect(
      service.reviewKycForAdmin({
        actorUserId,
        targetUserId,
        decision: 'rejected',
        rejectionReason: 'bad',
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(userModel.findOneAndUpdate).toBeUndefined();
  });

  it.each([
    ['verified', 'verified'],
    ['rejected', 'rejected'],
    ['verified', 'rejected'],
    ['rejected', 'verified'],
  ] as const)(
    'rejects a %s decision when the current state is already %s',
    async (decision, currentStatus) => {
      const { service, userModel, auditLogService } = createService();
      mockConditionalUpdate(userModel, null, {
        kycStatus: currentStatus,
        kycVersion: 2,
      });

      await expect(
        service.reviewKycForAdmin({
          actorUserId,
          targetUserId,
          decision,
          rejectionReason:
            decision === 'rejected' ? 'Valid rejection reason' : undefined,
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'KYC_ALREADY_REVIEWED' }),
      });
      expect(auditLogService.logRequired).not.toHaveBeenCalled();
    },
  );

  it('returns a deterministic conflict for a stale pending version', async () => {
    const { service, userModel } = createService();
    mockConditionalUpdate(userModel, null, {
      kycStatus: 'pending',
      kycVersion: 5,
    });

    await expect(
      service.reviewKycForAdmin({
        actorUserId,
        targetUserId,
        decision: 'verified',
        expectedVersion: 4,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'KYC_REVIEW_VERSION_CONFLICT' }),
    });
  });

  it('allows only one winner in a two-admin review race', async () => {
    const { service, userModel, auditLogService } = createService();
    const reviewed = {
      kycStatus: 'verified',
      kycVersion: 2,
      kycReviewedAt: new Date(),
    };
    userModel.findOneAndUpdate = jest
      .fn()
      .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(reviewed) })
      .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(null) });
    userModel.findById = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        session: jest.fn().mockReturnValue({ lean: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ kycStatus: 'verified', kycVersion: 2 }) }) }),
      }),
    });

    const attempts = await Promise.allSettled([
      service.reviewKycForAdmin({
        actorUserId,
        targetUserId,
        decision: 'verified',
        expectedVersion: 1,
      }),
      service.reviewKycForAdmin({
        actorUserId: '64b000000000000000000003',
        targetUserId,
        decision: 'rejected',
        rejectionReason: 'Concurrent rejection attempt',
        expectedVersion: 1,
      }),
    ]);

    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(auditLogService.logRequired).toHaveBeenCalledTimes(1);
  });

});
