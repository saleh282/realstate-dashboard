'use strict';

const { ConflictException, ForbiddenException } = require('../src/common/http/errors');
const { Types } = require('mongoose');
const bcrypt = require('bcrypt');
const { AccountDeletionService } = require('../src/services/account-deletion.service');
const { AccountDeletionState } = require('../src/domain/account-deletion/account-deletion.types');
const {
  AccountStatus,
  AccountType,
  BrokerStatus,
  VerificationTrustState,
} = require('../src/domain/users/identity.types');
const { SystemRole } = require('../src/domain/auth/roles.enum');
const { AuthErrorCode } = require('../src/common/errors/auth-error-codes');
function query(value) {
  const chain = {
    select: jest.fn(() => chain),
    sort: jest.fn(() => chain),
    lean: jest.fn(() => chain),
    exec: jest.fn().mockResolvedValue(value),
  };
  return chain;
}
function workflow(overrides = {}) {
  const now = new Date();
  return {
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId('64b000000000000000000002'),
    workflowVersion: 1,
    version: 0,
    state: AccountDeletionState.PENDING,
    requestedAt: now,
    recoverableUntil: new Date(now.getTime() + 30 * 86400_000),
    legalHold: false,
    blockers: [],
    ...overrides,
  };
}
function createService(options = {}) {
  const userId = new Types.ObjectId('64b000000000000000000002');
  const user = {
    _id: userId,
    fullName: 'Person',
    email: 'person@example.com',
    password: '',
    systemRole: SystemRole.USER,
    accountType: AccountType.USER,
    accountStatus: AccountStatus.ACTIVE,
    brokerStatus: BrokerStatus.NOT_APPLIED,
    verificationTrustState: VerificationTrustState.UNVERIFIED,
  };
  const users = {
    findById: jest.fn(() => query(user)),
    findOne: jest.fn(() => query(user)),
    updateOne: jest.fn(() => ({ exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }) })),
  };
  const properties = {
    countDocuments: jest.fn(() => ({
      exec: jest.fn().mockResolvedValue(options.propertyBlockers ?? 0),
    })),
  };
  const created = workflow();
  const requests = {
    findOne: jest
      .fn()
      .mockImplementationOnce(() => query(options.active ?? null))
      .mockImplementationOnce(() => query(options.latest ?? null)),
    create: jest.fn().mockResolvedValue([created]),
    findOneAndUpdate: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(workflow()) })),
    updateOne: jest.fn(() => ({ exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }) })),
  };
  const session = {
    withTransaction: jest.fn(async (callback) => callback()),
    endSession: jest.fn().mockResolvedValue(undefined),
  };
  const connection = { startSession: jest.fn().mockResolvedValue(session) };
  const refreshTokens = { revokeAllForUser: jest.fn().mockResolvedValue(undefined) };
  const audit = {
    logRequired: jest.fn().mockResolvedValue(undefined),
    logAdminAction: jest.fn().mockResolvedValue(undefined),
  };
  const service = new AccountDeletionService(
    users,
    properties,
    requests,
    connection,
    refreshTokens,
    audit,
  );
  return { service, user, users, properties, requests, refreshTokens, audit, created };
}
describe('MAZAD-017 retention-safe account deletion', () => {
  it('moves ACTIVE to DELETION_PENDING, creates a durable workflow, and revokes sessions without deleting the user', async () => {
    const fixture = createService();
    fixture.user.password = await bcrypt.hash('CorrectPass123!', 4);
    const result = await fixture.service.requestSelfDeletion(
      fixture.user._id.toString(),
      'CorrectPass123!',
      '127.0.0.1',
    );
    expect(result).toMatchObject({
      state: AccountDeletionState.PENDING,
      workflowVersion: 1,
      recoverable: true,
    });
    expect(fixture.users.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ accountStatus: AccountStatus.ACTIVE }),
      expect.objectContaining({
        $set: expect.objectContaining({ accountStatus: AccountStatus.DELETION_PENDING }),
      }),
      expect.anything(),
    );
    expect(fixture.requests.create).toHaveBeenCalled();
    expect(fixture.refreshTokens.revokeAllForUser).toHaveBeenCalledWith(
      fixture.user._id.toString(),
      'ACCOUNT_DELETION_PENDING',
    );
    expect(fixture.users.findByIdAndDelete).toBeUndefined();
  });
  it('returns the existing active workflow deterministically for a repeated request', async () => {
    const existing = workflow();
    const fixture = createService({ active: existing });
    fixture.user.password = await bcrypt.hash('CorrectPass123!', 4);
    await expect(
      fixture.service.requestSelfDeletion(fixture.user._id.toString(), 'CorrectPass123!'),
    ).resolves.toMatchObject({ workflowVersion: 1 });
    expect(fixture.requests.create).not.toHaveBeenCalled();
  });
  it('returns a deterministic recovery-only login state instead of restoring', async () => {
    const fixture = createService({ active: workflow() });
    const error = await fixture.service
      .pendingLoginState(fixture.user._id.toString())
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.getResponse()).toMatchObject({ code: AuthErrorCode.ACCOUNT_DELETION_PENDING });
  });
  it('requires a valid unexpired pending workflow for credential recovery', async () => {
    const expired = workflow({ recoverableUntil: new Date(Date.now() - 1) });
    const fixture = createService({ active: expired });
    fixture.user.password = await bcrypt.hash('CorrectPass123!', 4);
    const error = await fixture.service
      .validateRecoveryCredentials('person@example.com', 'CorrectPass123!')
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({
      code: AuthErrorCode.ACCOUNT_RECOVERY_WINDOW_EXPIRED,
    });
  });
  it('rejects recovery after anonymization has started', async () => {
    const started = workflow({
      state: AccountDeletionState.ANONYMIZING,
      anonymizationStartedAt: new Date(),
    });
    const fixture = createService({ active: started });
    fixture.user.password = await bcrypt.hash('CorrectPass123!', 4);
    const error = await fixture.service
      .validateRecoveryCredentials('person@example.com', 'CorrectPass123!')
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ code: AuthErrorCode.ACCOUNT_RESTORE_NOT_ALLOWED });
  });
  it('restores atomically only after verified recovery and revokes every old session', async () => {
    const fixture = createService();
    fixture.requests.findOneAndUpdate.mockReturnValueOnce({
      exec: jest.fn().mockResolvedValue(workflow({ state: AccountDeletionState.RESTORED })),
    });
    await expect(
      fixture.service.restoreAfterVerification('person@example.com', 1),
    ).resolves.toMatchObject({ restored: true });
    expect(fixture.users.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ accountStatus: AccountStatus.DELETION_PENDING }),
      expect.objectContaining({
        $set: expect.objectContaining({ accountStatus: AccountStatus.ACTIVE }),
      }),
      expect.anything(),
    );
    expect(fixture.refreshTokens.revokeAllForUser).toHaveBeenCalledWith(
      fixture.user._id.toString(),
      'ACCOUNT_RESTORED_FRESH_LOGIN_REQUIRED',
    );
  });
  it('blocks anonymization while a property lifecycle blocker remains', async () => {
    const expired = workflow({ recoverableUntil: new Date(Date.now() - 1000) });
    const fixture = createService({ active: expired, propertyBlockers: 2 });
    fixture.requests.findOne.mockReset().mockReturnValue(query(expired));
    const error = await fixture.service
      .anonymize({
        actorUserId: '64b000000000000000000001',
        targetUserId: fixture.user._id.toString(),
        reason: 'Reviewed retention workflow',
        version: 0,
      })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ code: AuthErrorCode.ACCOUNT_DELETION_BLOCKED });
    expect(fixture.users.updateOne).not.toHaveBeenCalled();
  });
  it('places a legal hold atomically with an optimistic version predicate and audit record', async () => {
    const held = workflow({ legalHold: true, version: 1 });
    const fixture = createService();
    fixture.requests.findOneAndUpdate.mockReturnValueOnce({
      exec: jest.fn().mockResolvedValue(held),
    });
    await expect(
      fixture.service.setLegalHold({
        actorUserId: '64b000000000000000000001',
        targetUserId: fixture.user._id.toString(),
        reason: 'Pending legal review',
        version: 0,
        place: true,
      }),
    ).resolves.toMatchObject({ legalHold: true, version: 1 });
    expect(fixture.requests.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: fixture.user._id,
        state: AccountDeletionState.PENDING,
        version: 0,
        legalHold: false,
      }),
      expect.objectContaining({ $set: expect.objectContaining({ legalHold: true }) }),
      expect.objectContaining({ new: true }),
    );
    expect(fixture.audit.logRequired).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'Pending legal review' }),
      expect.anything(),
    );
  });
  it('does not anonymize an expired workflow while a legal hold is active', async () => {
    const held = workflow({
      legalHold: true,
      recoverableUntil: new Date(Date.now() - 1000),
    });
    const fixture = createService();
    fixture.requests.findOne.mockReset().mockReturnValue(query(held));
    const error = await fixture.service
      .anonymize({
        actorUserId: '64b000000000000000000001',
        targetUserId: fixture.user._id.toString(),
        reason: 'Attempt while held',
        version: 0,
      })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ code: AuthErrorCode.ACCOUNT_LEGAL_HOLD_ACTIVE });
    expect(fixture.users.updateOne).not.toHaveBeenCalled();
  });
  it('removes a legal hold without restoring or activating the account', async () => {
    const released = workflow({ legalHold: false, version: 2 });
    const fixture = createService();
    fixture.requests.findOneAndUpdate.mockReturnValueOnce({
      exec: jest.fn().mockResolvedValue(released),
    });
    await expect(
      fixture.service.setLegalHold({
        actorUserId: '64b000000000000000000001',
        targetUserId: fixture.user._id.toString(),
        reason: 'Legal review completed',
        version: 1,
        place: false,
      }),
    ).resolves.toMatchObject({ legalHold: false, version: 2 });
    expect(fixture.requests.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        state: AccountDeletionState.PENDING,
        version: 1,
        legalHold: true,
      }),
      expect.objectContaining({ $set: expect.objectContaining({ legalHold: false }) }),
      expect.objectContaining({ new: true }),
    );
    expect(fixture.users.updateOne).not.toHaveBeenCalled();
  });
  it('anonymizes PII but preserves the User ID, property references, evidence, and history', async () => {
    const expired = workflow({ recoverableUntil: new Date(Date.now() - 1000) });
    const fixture = createService({ propertyBlockers: 0 });
    fixture.requests.findOne.mockReset().mockReturnValue(query(expired));
    fixture.requests.findOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue(workflow({ state: AccountDeletionState.ANONYMIZING })),
    });
    await expect(
      fixture.service.anonymize({
        actorUserId: '64b000000000000000000001',
        targetUserId: fixture.user._id.toString(),
        reason: 'Recovery expired and no blockers remain',
        version: 0,
      }),
    ).resolves.toMatchObject({ state: AccountDeletionState.ANONYMIZED, finalPurgeEnabled: false });
    expect(fixture.users.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: fixture.user._id }),
      expect.objectContaining({
        $set: expect.objectContaining({
          fullName: 'Deleted Account',
          accountStatus: AccountStatus.ANONYMIZED,
        }),
        $unset: expect.objectContaining({ email: 1, phone: 1 }),
      }),
      expect.anything(),
    );
    expect(fixture.properties.deleteMany).toBeUndefined();
    expect(fixture.users.findByIdAndDelete).toBeUndefined();
  });
  it('returns the completed anonymization result deterministically when retried', async () => {
    const completed = workflow({
      state: AccountDeletionState.ANONYMIZED,
      anonymizedAt: new Date(),
    });
    const fixture = createService();
    fixture.requests.findOne
      .mockReset()
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(completed));
    await expect(
      fixture.service.anonymize({
        actorUserId: '64b000000000000000000001',
        targetUserId: fixture.user._id.toString(),
        reason: 'Retry after uncertain response',
        version: 0,
      }),
    ).resolves.toMatchObject({ state: AccountDeletionState.ANONYMIZED, finalPurgeEnabled: false });
    expect(fixture.users.updateOne).not.toHaveBeenCalled();
    expect(fixture.audit.logRequired).not.toHaveBeenCalled();
  });
});
