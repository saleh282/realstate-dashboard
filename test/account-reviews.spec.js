'use strict';

const request = require('supertest');
const { Types } = require('mongoose');
const { httpApp } = require('./support/http-app');
const { FakeModel, fakeConnection } = require('./support/fake-model');
const {
  AccountReviewsService,
  ReviewErrorCode,
} = require('../src/services/account-reviews.service');

const id = () => new Types.ObjectId();
const rejection = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return { status: error.getStatus(), ...error.getResponse() };
  }
  throw new Error('expected a rejection');
};

function setup() {
  const asset = (name) => ({
    publicId: `kyc/${name}`,
    resourceType: 'image',
    deliveryType: 'authenticated',
  });
  const user = (name, extra = {}) => ({
    _id: id(),
    fullName: name,
    email: `${name}@example.test`,
    accountType: 'USER',
    accountStatus: 'ACTIVE',
    brokerStatus: 'NOT_APPLIED',
    verificationTrustState: 'UNVERIFIED',
    kycStatus: 'not_submitted',
    kycVersion: 0,
    brokerVersion: 0,
    ...extra,
  });
  const waiting = user('mona', {
    kycStatus: 'pending',
    kycVersion: 2,
    kycSubmittedAt: new Date('2026-10-02'),
    idFrontAsset: asset('front'),
    idBackAsset: asset('back'),
    selfieAsset: asset('selfie'),
  });
  const earlier = user('omar', {
    kycStatus: 'pending',
    kycVersion: 1,
    kycSubmittedAt: new Date('2026-10-01'),
    idFrontAsset: asset('front2'),
  });
  const never = user('sara');
  const applicant = user('karim', { brokerStatus: 'PENDING', brokerVersion: 1 });
  const application = {
    _id: id(),
    applicantAccountId: applicant._id,
    status: 'PENDING',
    submittedAt: new Date('2026-10-03'),
    documentIds: [id()],
    version: 0,
  };
  const users = new FakeModel([waiting, earlier, never, applicant]);
  const applications = new FakeModel([application]);
  const documents = new FakeModel([
    {
      _id: id(),
      applicationId: application._id,
      assetRef: { publicId: 'broker/doc', resourceType: 'raw' },
    },
  ]);
  const assets = {
    downloadAuthenticatedAsset: jest.fn(async (requested) => ({
      buffer: Buffer.from(`bytes of ${requested.publicId}`),
      contentType: 'image/jpeg',
    })),
  };
  const auditLog = { logRequired: jest.fn().mockResolvedValue(undefined) };
  const outbox = { recordRequired: jest.fn().mockResolvedValue({}) };
  const now = new Date('2026-10-06T12:00:00Z');
  const service = new AccountReviewsService(
    users,
    applications,
    documents,
    assets,
    auditLog,
    outbox,
    fakeConnection(),
    () => now,
  );
  const ids = {
    waiting: String(waiting._id),
    earlier: String(earlier._id),
    never: String(never._id),
    applicant: String(applicant._id),
    application: String(application._id),
  };
  const actor = { userId: String(id()), ip: '1.1.1.1' };
  return { service, users, applications, assets, auditLog, outbox, ids, actor, now };
}

describe('reviewing identity checks', () => {
  it('queues what waits, oldest first, without the documents themselves', async () => {
    const { service, ids } = setup();
    const queue = await service.kycQueue();
    expect(queue).toMatchObject({ total: 2, page: 1, limit: 20 });
    expect(queue.items.map((item) => item.id)).toEqual([ids.earlier, ids.waiting]);
    expect(queue.items[1]).toMatchObject({
      name: 'mona',
      email: 'mona@example.test',
      kycStatus: 'pending',
      kycVersion: 2,
      documents: ['id-front', 'id-back', 'selfie'],
    });
    expect(queue.items[0].documents).toEqual(['id-front']);
    expect(JSON.stringify(queue)).not.toContain('kyc/front');
    for (const query of [
      { status: 'not_submitted' },
      { status: 'x' },
      { page: '0' },
      { limit: '99' },
    ]) {
      expect((await rejection(service.kycQueue(query))).status).toBe(400);
    }
  });
  it('never shows an account that sent nothing', async () => {
    const { service, ids, actor } = setup();
    for (const attempt of [
      service.kycOne(ids.never),
      service.kycOne(String(id())),
      service.approveKyc(actor, ids.never),
      service.kycDocument(actor, ids.never, 'selfie'),
    ]) {
      expect((await rejection(attempt)).status).toBe(404);
    }
    expect((await rejection(service.kycOne('nope'))).code).toBe(ReviewErrorCode.ID_INVALID);
  });
  it('hands out a document as a private file and records the look', async () => {
    const { service, assets, auditLog, ids, actor } = setup();
    const file = await service.kycDocument(actor, ids.waiting, 'id-back');
    expect(file.body.toString()).toBe('bytes of kyc/back');
    expect(file.options.type).toBe('image/jpeg');
    expect(assets.downloadAuthenticatedAsset).toHaveBeenCalledWith(
      expect.objectContaining({ publicId: 'kyc/back', deliveryType: 'authenticated' }),
    );
    expect(auditLog.logRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'private_evidence_accessed',
        actorUserId: actor.userId,
        targetUserId: ids.waiting,
      }),
    );
    // A photo that was not sent, and a name that is not one of the three.
    for (const [userId, name] of [
      [ids.earlier, 'selfie'],
      [ids.waiting, 'passport'],
      [ids.waiting, 'idFrontAsset'],
    ]) {
      expect(await rejection(service.kycDocument(actor, userId, name))).toMatchObject({
        status: 404,
        code: ReviewErrorCode.DOCUMENT_NOT_FOUND,
      });
    }
  });
  it('approval verifies the account, records who decided and tells it', async () => {
    const { service, users, auditLog, outbox, ids, actor, now } = setup();
    const { request: decided } = await service.approveKyc(actor, ids.waiting);
    expect(decided).toMatchObject({ kycStatus: 'verified', verified: true, reviewedAt: now });
    expect(users.docs[0]).toMatchObject({
      kycStatus: 'verified',
      verificationTrustState: 'VERIFIED',
    });
    expect(auditLog.logRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin_kyc_reviewed',
        actorUserId: actor.userId,
        targetUserId: ids.waiting,
        metadata: { decision: 'verified', kycVersion: 2 },
      }),
      expect.anything(),
    );
    expect(outbox.recordRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'KYC_APPROVED',
        aggregateId: ids.waiting,
        privateRouting: { subjectAccountId: ids.waiting },
      }),
      expect.anything(),
    );
  });
  it('refusal needs a reason, keeps the account unverified and keeps the reason off the event', async () => {
    const { service, users, outbox, ids, actor } = setup();
    for (const reason of [undefined, ' ', 'لا']) {
      expect(await rejection(service.rejectKyc(actor, ids.waiting, reason))).toMatchObject({
        status: 400,
        code: ReviewErrorCode.REASON_REQUIRED,
      });
    }
    const { request: decided } = await service.rejectKyc(actor, ids.waiting, ' الصورة غير واضحة ');
    expect(decided).toMatchObject({
      kycStatus: 'rejected',
      verified: false,
      rejectionReason: 'الصورة غير واضحة',
    });
    expect(users.docs[0].verificationTrustState).toBe('UNVERIFIED');
    const event = outbox.recordRequired.mock.calls.at(-1)[0];
    expect(event.type).toBe('KYC_REJECTED');
    expect(JSON.stringify(event)).not.toContain('الصورة');
  });
  it('a request is decided once', async () => {
    const { service, auditLog, ids, actor } = setup();
    await service.approveKyc(actor, ids.waiting);
    auditLog.logRequired.mockClear();
    for (const attempt of [
      service.approveKyc(actor, ids.waiting),
      service.rejectKyc(actor, ids.waiting, 'سبب كاف'),
    ]) {
      expect(await rejection(attempt)).toMatchObject({
        status: 409,
        code: ReviewErrorCode.ALREADY_DECIDED,
      });
    }
    expect(auditLog.logRequired).not.toHaveBeenCalled();
    expect((await service.kycQueue({ status: 'verified' })).total).toBe(1);
  });
});

describe('reviewing broker applications', () => {
  it('queues what waits with who applied', async () => {
    const { service, ids } = setup();
    const queue = await service.brokerQueue();
    expect(queue.total).toBe(1);
    expect(queue.items[0]).toMatchObject({
      id: ids.application,
      status: 'PENDING',
      hasDocument: true,
      rejectionReason: null,
      applicant: { id: ids.applicant, name: 'karim', email: 'karim@example.test' },
    });
    expect((await rejection(service.brokerQueue({ status: 'nope' }))).status).toBe(400);
    expect((await service.brokerOne(ids.application)).applicant.name).toBe('karim');
    expect((await rejection(service.brokerOne(String(id())))).status).toBe(404);
  });
  it('hands out the document privately and records the look', async () => {
    const { service, auditLog, ids, actor } = setup();
    const file = await service.brokerDocument(actor, ids.application);
    expect(file.body.toString()).toBe('bytes of broker/doc');
    expect(auditLog.logRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'private_evidence_accessed',
        targetUserId: ids.applicant,
        targetResourceId: ids.application,
      }),
    );
  });
  it('approval makes the account a broker and tells it', async () => {
    const { service, users, applications, auditLog, outbox, ids, actor, now } = setup();
    const { application } = await service.approveBroker(actor, ids.application);
    expect(application).toMatchObject({ status: 'APPROVED', reviewedAt: now });
    expect(applications.docs[0]).toMatchObject({ status: 'APPROVED', version: 1 });
    expect(users.docs[3]).toMatchObject({
      accountType: 'BROKER',
      brokerStatus: 'APPROVED',
      brokerVersion: 2,
    });
    expect(auditLog.logRequired.mock.calls.at(-1)[0]).toMatchObject({
      action: 'admin_broker_application_reviewed',
      targetUserId: ids.applicant,
      targetResourceId: ids.application,
    });
    expect(outbox.recordRequired.mock.calls.at(-1)[0]).toMatchObject({
      type: 'BROKER_APPLICATION_APPROVED',
      aggregateId: ids.application,
      privateRouting: { subjectAccountId: ids.applicant },
    });
  });
  it('refusal needs a reason and lets the account apply again', async () => {
    const { service, users, ids, actor } = setup();
    expect((await rejection(service.rejectBroker(actor, ids.application, ''))).code).toBe(
      ReviewErrorCode.REASON_REQUIRED,
    );
    const { application } = await service.rejectBroker(actor, ids.application, 'المستند غير مقروء');
    expect(application).toMatchObject({ status: 'REJECTED', rejectionReason: 'المستند غير مقروء' });
    expect(users.docs[3]).toMatchObject({ accountType: 'USER', brokerStatus: 'REJECTED' });
    expect(await rejection(service.approveBroker(actor, ids.application))).toMatchObject({
      status: 409,
      code: ReviewErrorCode.ALREADY_DECIDED,
    });
  });
});

describe('the reviews over HTTP', () => {
  const account = (overrides = {}) => ({
    userId: String(id()),
    systemRole: 'USER',
    accountType: 'USER',
    accountStatus: 'ACTIVE',
    brokerStatus: 'NOT_APPLIED',
    ...overrides,
  });
  const accounts = { user: account(), admin: account({ systemRole: 'ADMIN' }) };
  let app;
  let ids;
  const as = (name) => ['Authorization', `Bearer ${name}`];
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    const context = setup();
    ids = context.ids;
    const routes = require('../src/routes/admin-reviews.routes');
    app = httpApp(
      { AccountReviewsService: context.service },
      (target, provided) => {
        target.use('/api/v1/admin/kyc', routes.createKycRouter(provided));
        target.use('/api/v1/admin/broker-applications', routes.createBrokerRouter(provided));
      },
      async (req) => {
        req.user = accounts[req.headers.authorization.replace('Bearer ', '')];
      },
    );
    await app.init();
  });
  afterAll(async () => app.close());

  it('serves a document as an uncached image, not as JSON', async () => {
    const response = await api()
      .get(`/api/v1/admin/kyc/${ids.waiting}/documents/selfie`)
      .set(...as('admin'))
      .expect(200);
    expect(response.headers['content-type']).toContain('image/jpeg');
    expect(response.headers['cache-control']).toBe('private, no-store, max-age=0');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.body.toString()).toBe('bytes of kyc/selfie');
  });
  it('lets staff decide both kinds of request', async () => {
    await api()
      .post(`/api/v1/admin/kyc/${ids.waiting}/reject`)
      .set(...as('admin'))
      .send({})
      .expect(400);
    await api()
      .post(`/api/v1/admin/kyc/${ids.waiting}/approve`)
      .set(...as('admin'))
      .expect(200);
    await api()
      .post(`/api/v1/admin/broker-applications/${ids.application}/reject`)
      .set(...as('admin'))
      .send({ reason: 'المستند غير مقروء' })
      .expect(200);
  });
  it('keeps everything from accounts that are not staff', async () => {
    const paths = [
      ['get', '/api/v1/admin/kyc'],
      ['get', `/api/v1/admin/kyc/${ids.earlier}`],
      ['get', `/api/v1/admin/kyc/${ids.earlier}/documents/id-front`],
      ['post', `/api/v1/admin/kyc/${ids.earlier}/approve`],
      ['post', `/api/v1/admin/kyc/${ids.earlier}/reject`],
      ['get', '/api/v1/admin/broker-applications'],
      ['get', `/api/v1/admin/broker-applications/${ids.application}`],
      ['get', `/api/v1/admin/broker-applications/${ids.application}/document`],
      ['post', `/api/v1/admin/broker-applications/${ids.application}/approve`],
      ['post', `/api/v1/admin/broker-applications/${ids.application}/reject`],
    ];
    for (const [method, path] of paths) {
      await api()[method](path).expect(401);
      await api()
        [method](path)
        .set(...as('user'))
        .expect(403);
    }
  });
});
