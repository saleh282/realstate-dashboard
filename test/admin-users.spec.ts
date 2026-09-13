import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '../src/auth/roles.enum';
import { UsersService } from '../src/users/users.service';
import { AuditAction } from '../src/audit/schemas/audit-log.schema';

const actorUserId = '64b000000000000000000001';
const targetUserId = '64b000000000000000000002';

function createService() {
  const userModel = {
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
