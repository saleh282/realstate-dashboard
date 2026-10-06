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
  // Other domains report what must be resolved before anonymization.
  const blockerProviders = [
    { blockersForAccount: jest.fn().mockResolvedValue(options.blockers ?? []) },
  ];
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
    requests,
    connection,
    refreshTokens,
    audit,
    blockerProviders,
  );
  return { service, user, users, requests, refreshTokens, audit, created };
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
});
