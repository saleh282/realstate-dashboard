'use strict';

const { AuditLogService } = require('../src/services/audit-log.service');
const { AuditAction } = require('../src/models/audit-log.model');
const actorUserId = '64b000000000000000000001';
const targetUserId = '64b000000000000000000002';
describe('KYC admin audit logging', () => {
  it('stores reviewer, target, and before/after metadata', async () => {
    const auditModel = { create: jest.fn().mockResolvedValue({}) };
    const service = new AuditLogService(auditModel);
    const metadata = {
      before: { kycStatus: 'pending', kycVersion: 1 },
      after: { kycStatus: 'verified', kycVersion: 2 },
    };
    await service.logAdminAction(
      AuditAction.ADMIN_KYC_REVIEWED,
      actorUserId,
      targetUserId,
      'KYC approved',
      '127.0.0.1',
      metadata,
    );
    expect(auditModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.ADMIN_KYC_REVIEWED,
        reason: 'KYC approved',
        ip: '127.0.0.1',
        metadata,
      }),
    );
  });
  it('keeps the existing best-effort behavior when audit storage is unavailable', async () => {
    const auditModel = {
      create: jest.fn().mockRejectedValue(new Error('audit unavailable')),
    };
    const service = new AuditLogService(auditModel);
    await expect(
      service.logAdminAction(
        AuditAction.ADMIN_KYC_REVIEWED,
        actorUserId,
        targetUserId,
        'KYC approved',
      ),
    ).resolves.toBeUndefined();
  });
});
