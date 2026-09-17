import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { AdminBrokerApplicationsController } from '../src/broker-applications/admin-broker-applications.controller';
import { BrokerApplicationsService } from '../src/broker-applications/broker-applications.service';
import { BrokerApplicationStatus } from '../src/broker-applications/broker.types';
import { SystemRole } from '../src/auth/roles.enum';
import { ROLES_KEY } from '../src/auth/roles.decorator';
import { BrokerErrorCode } from '../src/common/errors/broker-error-codes';
import { AssetClassification } from '../src/config/evidence-asset.types';
import { AccountStatus, AccountType, BrokerStatus } from '../src/users/identity.types';

const applicantId = new Types.ObjectId('64b000000000000000000001');
const adminId = new Types.ObjectId('64b000000000000000000002');
const applicationId = new Types.ObjectId('64b000000000000000000003');
const documentId = new Types.ObjectId('64b000000000000000000004');
const requirementId = new Types.ObjectId('64b000000000000000000005');

const png = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000000000000000000049454e4400000000',
  'hex',
);

function file(fieldname = 'GENERIC_BUSINESS_EVIDENCE') {
  return {
    fieldname,
    originalname: 'evidence.png',
    mimetype: 'image/png',
    buffer: png,
  } as Express.Multer.File;
}

function query<T>(value: T) {
  const chain: any = {
    session: jest.fn(() => chain),
    lean: jest.fn(() => chain),
    sort: jest.fn(() => chain),
    skip: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    exec: jest.fn().mockResolvedValue(value),
  };
  return chain;
}

function baseUser(overrides: Record<string, unknown> = {}) {
  return {
    _id: applicantId,
    systemRole: SystemRole.USER,
    accountType: AccountType.USER,
    accountStatus: AccountStatus.ACTIVE,
    brokerStatus: BrokerStatus.NOT_APPLIED,
    brokerVersion: 0,
    ...overrides,
  };
}

function requirement(overrides: Record<string, unknown> = {}) {
  return {
    _id: requirementId,
    code: 'GENERIC_BUSINESS_EVIDENCE',
    labelAr: 'مستند مهني عام',
    labelEn: 'Generic professional evidence',
    required: true,
    isActive: true,
    sortOrder: 1,
    version: 0,
    ...overrides,
  };
}

function pendingApplication(overrides: Record<string, unknown> = {}) {
  return {
    _id: applicationId,
    applicantAccountId: applicantId,
    applicationVersion: 1,
    status: BrokerApplicationStatus.PENDING,
    documentIds: [documentId],
    submittedAt: new Date('2026-09-17T12:00:00Z'),
    version: 0,
    ...overrides,
  };
}

function setup() {
  const applicationModel: any = {
    findOne: jest.fn(),
    findById: jest.fn(),
    find: jest.fn(),
    countDocuments: jest.fn(() => query(0)),
    create: jest.fn(),
    findOneAndUpdate: jest.fn(),
  };
  const documentModel: any = {
    create: jest.fn().mockResolvedValue([]),
    find: jest.fn(),
    findOne: jest.fn(),
  };
  const requirementModel: any = {
    find: jest.fn(),
    findById: jest.fn(),
    findOneAndUpdate: jest.fn(),
    create: jest.fn(),
  };
  const userModel: any = {
    findById: jest.fn(),
    updateOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
  };
  const connection = {
    transaction: jest.fn(async (callback: (session: object) => unknown) => callback({})),
  };
  const assets = {
    uploadPrivateEvidence: jest.fn().mockResolvedValue({
      publicId: 'private-broker-asset',
      resourceType: 'image',
      deliveryType: 'authenticated',
      classification: AssetClassification.PRIVATE_BROKER_EVIDENCE,
      format: 'png',
      bytes: png.length,
    }),
    deleteOrEnqueue: jest.fn().mockResolvedValue(undefined),
  };
  const audit = {
    logRequired: jest.fn().mockResolvedValue(undefined),
    logResourceAction: jest.fn().mockResolvedValue(undefined),
    logAdminAction: jest.fn().mockResolvedValue(undefined),
  };
  const service = new BrokerApplicationsService(
    applicationModel,
    documentModel,
    requirementModel,
    userModel,
    connection as any,
    assets as any,
    audit as any,
  );
  return {
    service,
    applicationModel,
    documentModel,
    requirementModel,
    userModel,
    connection,
    assets,
    audit,
  };
}

function arrangeSubmission(
  harness: ReturnType<typeof setup>,
  user = baseUser(),
  latest: any = null,
) {
  harness.userModel.findById.mockReturnValue(query(user));
  harness.requirementModel.find.mockReturnValue(query([requirement()]));
  harness.applicationModel.findOne
    .mockReturnValueOnce(query(null))
    .mockReturnValueOnce(query(null))
    .mockReturnValueOnce(query(latest));
  harness.documentModel.create.mockImplementation(async (rows: any[]) => rows);
  harness.applicationModel.create.mockImplementation(async (rows: any[]) => rows);
  harness.userModel.updateOne.mockReturnValue(query({ modifiedCount: 1 }));
}

describe('MAZAD-012 broker application lifecycle', () => {
  it('submits a USER application without self-promoting and stores private evidence', async () => {
    const harness = setup();
    arrangeSubmission(harness);

    const result = await harness.service.submitApplication(
      applicantId.toString(),
      [file()],
      'request-key-0001',
      '127.0.0.1',
    );

    expect(result.application).toMatchObject({
      applicationVersion: 1,
      status: BrokerApplicationStatus.PENDING,
      version: 0,
    });
    expect(harness.assets.uploadPrivateEvidence).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('brokers/'),
      AssetClassification.PRIVATE_BROKER_EVIDENCE,
      expect.anything(),
    );
    expect(harness.userModel.updateOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: { accountType: AccountType.USER, brokerStatus: BrokerStatus.PENDING },
      }),
      expect.objectContaining({ session: expect.anything() }),
    );
    expect(harness.audit.logRequired).toHaveBeenCalled();
  });

  it.each([BrokerStatus.REJECTED, BrokerStatus.REVOKED])(
    'creates a new immutable version after %s',
    async (brokerStatus) => {
      const harness = setup();
      arrangeSubmission(
        harness,
        baseUser({ brokerStatus, brokerVersion: 4 }),
        pendingApplication({ status: BrokerApplicationStatus.REJECTED, applicationVersion: 2 }),
      );
      const result = await harness.service.submitApplication(
        applicantId.toString(),
        [file()],
        `reapply-${brokerStatus}`,
      );
      expect(result.application.applicationVersion).toBe(3);
      expect(harness.applicationModel.create.mock.calls[0][0][0]).toMatchObject({
        applicationVersion: 3,
        status: BrokerApplicationStatus.PENDING,
      });
    },
  );

  it('rejects a second pending submission before uploading evidence', async () => {
    const harness = setup();
    harness.applicationModel.findOne.mockReturnValue(query(null));
    harness.userModel.findById.mockReturnValue(
      query(baseUser({ brokerStatus: BrokerStatus.PENDING })),
    );
    harness.requirementModel.find.mockReturnValue(query([requirement()]));

    const error = await harness.service
      .submitApplication(applicantId.toString(), [file()], 'pending-request')
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ code: BrokerErrorCode.APPLICATION_PENDING });
    expect(harness.assets.uploadPrivateEvidence).not.toHaveBeenCalled();
  });

  it('returns the same application for an idempotent replay without uploading again', async () => {
    const harness = setup();
    harness.applicationModel.findOne.mockReturnValue(query(pendingApplication()));
    const result = await harness.service.submitApplication(
      applicantId.toString(),
      [file()],
      'same-request-key',
    );
    expect(result.application).toMatchObject({
      id: applicationId.toString(),
      applicationVersion: 1,
    });
    expect(harness.assets.uploadPrivateEvidence).not.toHaveBeenCalled();
    expect(harness.connection.transaction).not.toHaveBeenCalled();
  });

  it('requires every active required generic document and rejects unknown codes', async () => {
    const missing = setup();
    arrangeSubmission(missing);
    await expect(
      missing.service.submitApplication(applicantId.toString(), [], 'missing-docs-key'),
    ).rejects.toBeInstanceOf(BadRequestException);

    const unknown = setup();
    arrangeSubmission(unknown);
    const error = await unknown.service
      .submitApplication(applicantId.toString(), [file('HARDCODED_UNKNOWN')], 'unknown-doc-key')
      .catch((caught) => caught);
    expect(error.getResponse()).toMatchObject({ code: BrokerErrorCode.REQUIREMENT_INVALID });
  });

  it('compensates successful private uploads when a parallel upload fails', async () => {
    const harness = setup();
    const requirements = [
      requirement(),
      requirement({
        _id: new Types.ObjectId(),
        code: 'SECOND_GENERIC_DOCUMENT',
        labelAr: 'مستند عام ثان',
      }),
    ];
    harness.applicationModel.findOne.mockReturnValue(query(null));
    harness.userModel.findById.mockReturnValue(query(baseUser()));
    harness.requirementModel.find.mockReturnValue(query(requirements));
    harness.assets.uploadPrivateEvidence
      .mockResolvedValueOnce({
        publicId: 'uploaded-before-failure',
        resourceType: 'image',
        deliveryType: 'authenticated',
        classification: AssetClassification.PRIVATE_BROKER_EVIDENCE,
      })
      .mockRejectedValueOnce(new Error('provider failure'));

    await expect(
      harness.service.submitApplication(
        applicantId.toString(),
        [file(), file('SECOND_GENERIC_DOCUMENT')],
        'partial-upload-key',
      ),
    ).rejects.toThrow('provider failure');
    expect(harness.assets.deleteOrEnqueue).toHaveBeenCalledWith(
      [expect.objectContaining({ publicId: 'uploaded-before-failure' })],
      'partial-broker-application-upload',
    );
  });

  it('approves a pending version and atomically promotes the account', async () => {
    const harness = setup();
    const before = pendingApplication();
    harness.applicationModel.findById.mockReturnValue(query(before));
    harness.applicationModel.findOneAndUpdate.mockReturnValue(
      query({ ...before, status: BrokerApplicationStatus.APPROVED, version: 1 }),
    );
    harness.userModel.findOneAndUpdate.mockReturnValue(
      query(baseUser({ accountType: AccountType.BROKER, brokerStatus: BrokerStatus.APPROVED, brokerVersion: 2 })),
    );

    const result = await harness.service.reviewApplication({
      applicationId: applicationId.toString(),
      decision: 'APPROVED',
      expectedVersion: 0,
      actorUserId: adminId.toString(),
    });
    expect(result.account).toMatchObject({
      accountType: AccountType.BROKER,
      brokerStatus: BrokerStatus.APPROVED,
    });
    expect(harness.connection.transaction).toHaveBeenCalledTimes(1);
    expect(harness.audit.logRequired).toHaveBeenCalled();
  });

  it('rejects with a mandatory reason and leaves account type USER', async () => {
    const noReason = setup();
    await expect(
      noReason.service.reviewApplication({
        applicationId: applicationId.toString(),
        decision: 'REJECTED',
        expectedVersion: 0,
        actorUserId: adminId.toString(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const harness = setup();
    const before = pendingApplication();
    harness.applicationModel.findById.mockReturnValue(query(before));
    harness.applicationModel.findOneAndUpdate.mockReturnValue(
      query({ ...before, status: BrokerApplicationStatus.REJECTED, version: 1, reviewReason: 'المستند غير واضح' }),
    );
    harness.userModel.findOneAndUpdate.mockReturnValue(
      query(baseUser({ brokerStatus: BrokerStatus.REJECTED, brokerVersion: 2 })),
    );
    const result = await harness.service.reviewApplication({
      applicationId: applicationId.toString(),
      decision: 'REJECTED',
      reason: 'المستند غير واضح',
      expectedVersion: 0,
      actorUserId: adminId.toString(),
    });
    expect(result.account).toMatchObject({
      accountType: AccountType.USER,
      brokerStatus: BrokerStatus.REJECTED,
    });
  });

  it('returns deterministic conflicts for stale and repeated Admin reviews', async () => {
    const stale = setup();
    stale.applicationModel.findById.mockReturnValue(query(pendingApplication({ version: 2 })));
    const staleError = await stale.service.reviewApplication({
      applicationId: applicationId.toString(),
      decision: 'APPROVED',
      expectedVersion: 1,
      actorUserId: adminId.toString(),
    }).catch((caught) => caught);
    expect(staleError.getResponse()).toMatchObject({
      code: BrokerErrorCode.APPLICATION_VERSION_CONFLICT,
      details: { state: BrokerApplicationStatus.PENDING, version: 2 },
    });

    const repeated = setup();
    repeated.applicationModel.findById.mockReturnValue(
      query(pendingApplication({ status: BrokerApplicationStatus.APPROVED, version: 1 })),
    );
    const repeatError = await repeated.service.reviewApplication({
      applicationId: applicationId.toString(),
      decision: 'REJECTED',
      reason: 'محاولة قرار مكرر',
      expectedVersion: 1,
      actorUserId: adminId.toString(),
    }).catch((caught) => caught);
    expect(repeatError.getResponse()).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it.each([
    ['suspendBroker', BrokerStatus.APPROVED, BrokerStatus.SUSPENDED, AccountType.BROKER],
    ['restoreBroker', BrokerStatus.SUSPENDED, BrokerStatus.APPROVED, AccountType.BROKER],
    ['revokeBroker', BrokerStatus.APPROVED, BrokerStatus.REVOKED, AccountType.USER],
  ] as const)(
    '%s enforces the frozen broker transition with optimistic versioning',
    async (method, currentStatus, nextStatus, nextAccountType) => {
      const harness = setup();
      harness.userModel.findById.mockReturnValue(query(baseUser({
        accountType: AccountType.BROKER,
        brokerStatus: currentStatus,
        brokerVersion: 3,
      })));
      harness.userModel.findOneAndUpdate.mockReturnValue(query(baseUser({
        accountType: nextAccountType,
        brokerStatus: nextStatus,
        brokerVersion: 4,
      })));
      const result = await harness.service[method](
        applicantId.toString(),
        3,
        'سبب إداري موثق',
        { actorUserId: adminId.toString() },
      );
      expect(result.account).toMatchObject({
        accountType: nextAccountType,
        brokerStatus: nextStatus,
        brokerVersion: 4,
      });
    },
  );

  it('rejects stale broker privilege transitions', async () => {
    const harness = setup();
    harness.userModel.findById.mockReturnValue(query(baseUser({
      accountType: AccountType.BROKER,
      brokerStatus: BrokerStatus.APPROVED,
      brokerVersion: 4,
    })));
    const error = await harness.service.suspendBroker(
      applicantId.toString(),
      3,
      'سبب إداري موثق',
      { actorUserId: adminId.toString() },
    ).catch((caught) => caught);
    expect(error.getResponse()).toMatchObject({
      code: BrokerErrorCode.STATUS_VERSION_CONFLICT,
      details: { state: BrokerStatus.APPROVED, version: 4 },
    });
  });

  it('allows only the exact applicant or Admin delivery path and never projects asset references', async () => {
    const harness = setup();
    const storedDocument = {
      _id: documentId,
      applicationId,
      applicantAccountId: applicantId,
      requirementCode: 'GENERIC_BUSINESS_EVIDENCE',
      requirementVersion: 0,
      requirementLabelAr: 'مستند مهني عام',
      submittedAt: new Date(),
      assetRef: {
        publicId: 'secret-provider-id',
        resourceType: 'image',
        deliveryType: 'authenticated',
        classification: AssetClassification.PRIVATE_BROKER_EVIDENCE,
        format: 'png',
        bytes: 100,
      },
    };
    harness.documentModel.findOne.mockImplementation((filter: any) =>
      query(filter.applicantAccountId?.toString() === applicantId.toString() ? storedDocument : null),
    );
    await expect(
      harness.service.getEvidenceForApplicant(
        new Types.ObjectId().toString(),
        applicationId.toString(),
        documentId.toString(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    harness.applicationModel.findById.mockReturnValue(query(pendingApplication()));
    harness.documentModel.find.mockReturnValue(query([storedDocument]));
    const detail = await harness.service.getApplicationForAdmin(applicationId.toString());
    expect(detail.documents[0]).not.toHaveProperty('assetRef');
    expect(JSON.stringify(detail)).not.toContain('secret-provider-id');
  });

  it('protects all Admin broker routes with ADMIN/SUPER_ADMIN-compatible role metadata', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminBrokerApplicationsController)).toEqual([
      SystemRole.ADMIN,
    ]);
  });
});
