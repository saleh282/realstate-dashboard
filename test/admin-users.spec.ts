import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { UserRole } from '../src/auth/roles.enum';
import { UsersService } from '../src/users/users.service';
import { AuditAction } from '../src/audit/schemas/audit-log.schema';

const actorUserId = '64b000000000000000000001';
const targetUserId = '64b000000000000000000002';

function createService() {
  const userModel: Record<string, any> = {
    findByIdAndDelete: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(undefined),
    }),
  };
  const refreshTokenService = {
    revokeAllForUser: jest.fn().mockResolvedValue(undefined),
  };
  const auditLogService = {
    log: jest.fn(),
    logAdminAction: jest.fn().mockResolvedValue(undefined),
  };
  const cloudinaryAssetService = {
    deleteAssets: jest.fn().mockResolvedValue(undefined),
  };
  const service = new UsersService(
    userModel as any,
    refreshTokenService as any,
    auditLogService as any,
    cloudinaryAssetService as any,
  );

  return {
    service,
    userModel,
    refreshTokenService,
    auditLogService,
    cloudinaryAssetService,
  };
}

describe('admin user deletion', () => {
  it('prevents an administrator from deleting their own account', async () => {
    const { service } = createService();

    await expect(
      service.deleteForAdmin({
        actorUserId,
        targetUserId: actorUserId,
        confirmIdentifier: 'admin@example.com',
        reason: 'Requested by administrator',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('prevents deleting another administrator', async () => {
    const { service } = createService();
    jest.spyOn(service, 'findById').mockResolvedValue({
      role: UserRole.ADMIN,
      email: 'other-admin@example.com',
    } as any);

    await expect(
      service.deleteForAdmin({
        actorUserId,
        targetUserId,
        confirmIdentifier: 'other-admin@example.com',
        reason: 'Requested by administrator',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requires the exact user email or phone as deletion confirmation', async () => {
    const { service } = createService();
    jest.spyOn(service, 'findById').mockResolvedValue({
      role: UserRole.USER,
      email: 'person@example.com',
    } as any);

    await expect(
      service.deleteForAdmin({
        actorUserId,
        targetUserId,
        confirmIdentifier: 'wrong@example.com',
        reason: 'Duplicate test account',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cleans assets, revokes sessions, deletes the user, and records the actor', async () => {
    const {
      service,
      userModel,
      refreshTokenService,
      auditLogService,
      cloudinaryAssetService,
    } = createService();
    const user = {
      role: UserRole.USER,
      email: 'person@example.com',
      idFrontAsset: { publicId: 'front' },
      idBackAsset: { publicId: 'back' },
      selfieAsset: { publicId: 'selfie' },
    };
    jest.spyOn(service, 'findById').mockResolvedValue(user as any);

    await expect(
      service.deleteForAdmin({
        actorUserId,
        targetUserId,
        confirmIdentifier: 'person@example.com',
        reason: 'Duplicate test account',
        ip: '127.0.0.1',
      }),
    ).resolves.toMatchObject({ userId: targetUserId });

    expect(cloudinaryAssetService.deleteAssets).toHaveBeenCalledWith([
      user.idFrontAsset,
      user.idBackAsset,
      user.selfieAsset,
    ]);
    expect(refreshTokenService.revokeAllForUser).toHaveBeenCalledWith(targetUserId);
    expect(userModel.findByIdAndDelete).toHaveBeenCalledWith(targetUserId);
    expect(auditLogService.logAdminAction).toHaveBeenCalledWith(
      AuditAction.ADMIN_USER_DELETED,
      actorUserId,
      targetUserId,
      'Duplicate test account',
      '127.0.0.1',
    );
  });
});


describe('admin user status management', () => {
  it('prevents self-suspension', async () => {
    const { service } = createService();
    await expect(
      service.updateStatusForAdmin({
        actorUserId,
        targetUserId: actorUserId,
        isActive: false,
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
        targetUserId,
        isActive: false,
        reason: 'Suspension test',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('suspends user, revokes their sessions, and logs action', async () => {
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
      targetUserId,
      isActive: false,
      reason: 'Violation of terms',
      ip: '127.0.0.1',
    });

    expect(result.isActive).toBe(false);
    expect(refreshTokenService.revokeAllForUser).toHaveBeenCalledWith(targetUserId);
    expect(auditLogService.logAdminAction).toHaveBeenCalledWith(
      AuditAction.ADMIN_USER_STATUS_UPDATED,
      actorUserId,
      targetUserId,
      'Violation of terms',
      '127.0.0.1',
    );
  });
});

describe('admin session revocation and role update', () => {
  it('revokes all user sessions and logs audit', async () => {
    const { service, refreshTokenService, auditLogService } = createService();
    jest.spyOn(service, 'findById').mockResolvedValue({ role: UserRole.USER } as any);

    await service.revokeSessionsForAdmin({
      actorUserId,
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

  it('prevents changing own role', async () => {
    const { service } = createService();
    await expect(
      service.updateRoleForAdmin({
        actorUserId,
        targetUserId: actorUserId,
        role: UserRole.USER,
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
      targetUserId,
      role: UserRole.ADMIN,
      reason: 'Promoted to support admin',
    });

    expect(result.role).toBe(UserRole.ADMIN);
    expect(refreshTokenService.revokeAllForUser).toHaveBeenCalledWith(targetUserId);
    expect(auditLogService.logAdminAction).toHaveBeenCalledWith(
      AuditAction.ADMIN_USER_ROLE_UPDATED,
      actorUserId,
      targetUserId,
      'Promoted to support admin',
      undefined,
    );
  });
});

describe('admin KYC document metadata', () => {
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
    ).resolves.toBe(idBackAsset);
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
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(current),
        }),
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
    const { service, userModel, auditLogService } = createService();
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
      { new: true, runValidators: true },
    );
    expect(auditLogService.logAdminAction).toHaveBeenCalledWith(
      AuditAction.ADMIN_KYC_REVIEWED,
      actorUserId,
      targetUserId,
      expect.any(String),
      '127.0.0.1',
      expect.objectContaining({
        before: { kycStatus: 'pending', kycVersion: 3 },
        after: expect.objectContaining({
          kycStatus: expectedStatus,
          kycVersion: 4,
        }),
      }),
    );
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
      expect(auditLogService.logAdminAction).not.toHaveBeenCalled();
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
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue({
            kycStatus: 'verified',
            kycVersion: 2,
          }),
        }),
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
    expect(auditLogService.logAdminAction).toHaveBeenCalledTimes(1);
  });

});
