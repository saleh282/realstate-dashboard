'use strict';

const request = require('supertest');
const { Types } = require('mongoose');
const { httpApp } = require('./support/http-app');
const { FakeModel } = require('./support/fake-model');
const { ListingReportsService } = require('../src/services/listing-reports.service');
const { ListingErrorCode } = require('../src/common/errors/listing-error-codes');

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
  const owner = { _id: id(), fullName: 'معلن' };
  const reporter = { _id: id(), fullName: 'سارة', email: 'sara@example.test' };
  const other = { _id: id(), fullName: 'علي', email: 'ali@example.test' };
  const listing = (status, extra = {}) => ({
    _id: id(),
    ownerId: owner._id,
    status,
    category: 'residential',
    titleAr: 'شقة للبيع',
    price: 100,
    photos: [{ _id: id(), url: 'https://cdn.example/f.jpg', shot: 'facade' }],
    ...extra,
  });
  const published = listing('published');
  const second = listing('published', { titleAr: 'محل للإيجار' });
  const pending = listing('pending_review');
  const reports = new FakeModel();
  const auditLog = { logRequired: jest.fn().mockResolvedValue(undefined) };
  const now = new Date('2026-10-06T12:00:00Z');
  const service = new ListingReportsService(
    reports,
    new FakeModel([published, second, pending]),
    new FakeModel([owner, reporter, other]),
    auditLog,
    () => now,
  );
  const ids = Object.fromEntries(
    Object.entries({ owner, reporter, other, published, second, pending }).map(([name, doc]) => [
      name,
      String(doc._id),
    ]),
  );
  return { service, reports, auditLog, ids, now };
}

describe('reporting a listing', () => {
  it('records the report once per account', async () => {
    const { service, reports, ids } = setup();
    await service.report(ids.reporter, ids.published, { reason: 'fraud', details: '  طلب مقدم  ' });
    // Sent again, with another reason: the first report stands.
    await service.report(ids.reporter, ids.published, { reason: 'duplicate' });
    await service.report(ids.other, ids.published, { reason: 'wrong_price' });
    expect(reports.docs).toHaveLength(2);
    expect(reports.docs[0]).toMatchObject({ reason: 'fraud', details: 'طلب مقدم', status: 'open' });
    expect(reports.docs[1]).not.toHaveProperty('details');
  });
  it('needs a known reason and short details', async () => {
    const { service, ids } = setup();
    for (const body of [
      undefined,
      {},
      { reason: 'boring' },
      { reason: 'fraud', details: 'x'.repeat(501) },
    ]) {
      expect(await rejection(service.report(ids.reporter, ids.published, body))).toMatchObject({
        status: 400,
        code: ListingErrorCode.REPORT_INVALID,
      });
    }
  });
  it("only takes reports on published listings, and never on one's own", async () => {
    const { service, ids } = setup();
    for (const listingId of [ids.pending, String(id())]) {
      expect(
        await rejection(service.report(ids.reporter, listingId, { reason: 'fraud' })),
      ).toMatchObject({
        status: 404,
      });
    }
    expect(
      (await rejection(service.report(ids.reporter, 'nope', { reason: 'fraud' }))).status,
    ).toBe(400);
    expect(
      await rejection(service.report(ids.owner, ids.published, { reason: 'fraud' })),
    ).toMatchObject({
      status: 400,
      code: ListingErrorCode.REPORT_INVALID,
    });
  });
});

describe('reading the reports', () => {
  it('lists the open ones with their listing, who sent them and how many it has', async () => {
    const { service, reports, ids } = setup();
    await service.report(ids.reporter, ids.published, { reason: 'fraud', details: 'طلب مقدم' });
    await service.report(ids.other, ids.published, { reason: 'duplicate' });
    await service.report(ids.reporter, ids.second, { reason: 'unavailable' });
    reports.docs.forEach((doc, index) => (doc.createdAt = new Date(2026, 9, 1 + index)));

    const queue = await service.queue();
    expect(queue).toMatchObject({ total: 3, page: 1, limit: 20 });
    expect(queue.items.map((item) => item.reason)).toEqual(['unavailable', 'duplicate', 'fraud']);
    expect(queue.items[2]).toMatchObject({
      details: 'طلب مقدم',
      status: 'open',
      listing: {
        id: ids.published,
        titleAr: 'شقة للبيع',
        status: 'published',
        photoUrl: 'https://cdn.example/f.jpg',
        openReports: 2,
      },
      reporter: { name: 'سارة', email: 'sara@example.test' },
    });
    expect(queue.items[0].listing.openReports).toBe(1);
    expect((await service.queue({ limit: '2', page: '2' })).items).toHaveLength(1);
    expect((await service.queue({ status: 'reviewed' })).total).toBe(0);
    for (const query of [{ status: 'closed' }, { page: '0' }, { limit: '500' }, { page: 'x' }]) {
      expect((await rejection(service.queue(query))).status).toBe(400);
    }
  });
  it('keeps a report whose listing was deleted', async () => {
    const { service, reports, ids } = setup();
    await service.report(ids.reporter, ids.published, { reason: 'fraud' });
    service.listings.docs.length = 0;
    expect((await service.queue()).items[0].listing).toBeNull();
    expect(reports.docs).toHaveLength(1);
  });
  it('marks a report as looked at, once, and records who did', async () => {
    const { service, reports, auditLog, ids, now } = setup();
    await service.report(ids.reporter, ids.published, { reason: 'fraud' });
    const reportId = String(reports.docs[0]._id);
    const actor = { userId: String(id()), ip: '1.1.1.1' };
    await service.review(actor, reportId);
    expect(reports.docs[0]).toMatchObject({ status: 'reviewed', reviewedAt: now });
    expect(auditLog.logRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'listing_report_reviewed',
        actorUserId: actor.userId,
        targetResourceId: ids.published,
      }),
    );
    expect((await rejection(service.review(actor, reportId))).status).toBe(409);
    expect((await rejection(service.review(actor, String(id())))).status).toBe(404);
    expect((await service.queue()).total).toBe(0);
    expect((await service.queue({ status: 'reviewed' })).total).toBe(1);
  });
});

describe('reports over HTTP', () => {
  const account = (overrides = {}) => ({
    userId: String(id()),
    systemRole: 'USER',
    accountType: 'USER',
    accountStatus: 'ACTIVE',
    brokerStatus: 'NOT_APPLIED',
    ...overrides,
  });
  const accounts = {
    user: account(),
    suspended: account({ accountStatus: 'SUSPENDED' }),
    admin: account({ systemRole: 'ADMIN' }),
  };
  let app;
  let ids;
  const as = (name) => ['Authorization', `Bearer ${name}`];
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    const context = setup();
    ids = context.ids;
    const routes = require('../src/routes/listing-reports.routes');
    app = httpApp(
      { ListingReportsService: context.service },
      (target, provided) => {
        target.use('/api/v1/admin/reports', routes.createAdminRouter(provided));
        target.use('/api/v1/listings', routes.createRouter(provided));
      },
      async (req) => {
        req.user = accounts[req.headers.authorization.replace('Bearer ', '')];
      },
    );
    await app.init();
  });
  afterAll(async () => app.close());

  it('an account reports, staff read and mark it', async () => {
    await api()
      .post(`/api/v1/listings/${ids.published}/reports`)
      .set(...as('user'))
      .send({ reason: 'fraud', details: 'طلب تحويل مقدم' })
      .expect(201);
    const queue = await api()
      .get('/api/v1/admin/reports')
      .set(...as('admin'))
      .expect(200);
    expect(queue.body.data.items).toHaveLength(1);
    await api()
      .post(`/api/v1/admin/reports/${queue.body.data.items[0].id}/review`)
      .set(...as('admin'))
      .expect(200);
  });
  it('needs a sign-in in good standing to report, and staff to read', async () => {
    const path = `/api/v1/listings/${ids.published}/reports`;
    await api().post(path).send({ reason: 'fraud' }).expect(401);
    for (const name of ['suspended', 'admin']) {
      await api()
        .post(path)
        .set(...as(name))
        .send({ reason: 'fraud' })
        .expect(403);
    }
    await api().get('/api/v1/admin/reports').expect(401);
    await api()
      .get('/api/v1/admin/reports')
      .set(...as('user'))
      .expect(403);
    await api()
      .post(`/api/v1/admin/reports/${String(id())}/review`)
      .set(...as('user'))
      .expect(403);
  });
});
