'use strict';

const request = require('supertest');
const { Types } = require('mongoose');
const { httpApp } = require('./support/http-app');
const { FakeModel, fakeConnection } = require('./support/fake-model');
const { apartmentForSale } = require('./support/listing-fixtures');
const { ListingsService } = require('../src/services/listings.service');
const { requiredShots } = require('../src/domain/listings/photo-shots');
const { resetUploadBudgetForTests } = require('../src/common/uploads/upload-budget');

const png = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000000000000000000049454e4400000000',
  'hex',
);
const account = (overrides = {}) => ({
  userId: new Types.ObjectId().toString(),
  systemRole: 'USER',
  accountType: 'USER',
  accountStatus: 'ACTIVE',
  brokerStatus: 'NOT_APPLIED',
  ...overrides,
});

describe('listings over HTTP', () => {
  const accounts = {
    owner: account(),
    stranger: account(),
    suspended: account({ accountStatus: 'SUSPENDED' }),
    admin: account({ systemRole: 'ADMIN' }),
  };
  let app;
  let uploads = 0;
  const as = (name) => ['Authorization', `Bearer ${name}`];
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    resetUploadBudgetForTests?.();
    const users = new FakeModel(
      Object.values(accounts).map((item) => ({
        _id: new Types.ObjectId(item.userId),
        fullName: 'معلن',
        verificationTrustState: 'UNVERIFIED',
      })),
    );
    const assets = {
      uploadListingPhoto: async () => ({
        publicId: `p-${++uploads}`,
        secureUrl: `https://cdn.example/image/upload/p-${uploads}.jpg`,
      }),
      deleteOrEnqueue: async () => {},
    };
    const services = {
      ListingsService: new ListingsService(
        new FakeModel(),
        users,
        assets,
        { logRequired: async () => {} },
        { recordRequired: async () => ({}) },
        fakeConnection(),
      ),
    };
    app = httpApp(
      services,
      (target, provided) => {
        target.use(
          '/api/v1/admin/listings',
          require('../src/routes/admin-listings.routes').createRouter(provided),
        );
        target.use(
          '/api/v1/listings',
          require('../src/routes/listings.routes').createRouter(provided),
        );
      },
      async (req) => {
        const name = req.headers.authorization.replace('Bearer ', '');
        if (!accounts[name]) throw new Error('unknown test account');
        req.user = accounts[name];
      },
    );
    await app.init();
  });
  afterAll(async () => app.close());

  it('takes a listing from posting to the public list', async () => {
    const created = await api()
      .post('/api/v1/listings')
      .set(...as('owner'))
      .send(apartmentForSale())
      .expect(201);
    const { id } = created.body.data.listing;
    expect(created.body).toMatchObject({ success: true, data: { listing: { status: 'draft' } } });

    for (const shot of requiredShots({ category: 'residential' })) {
      await api()
        .put(`/api/v1/listings/${id}/photos/${shot}`)
        .set(...as('owner'))
        .attach('photo', png, { filename: 'p.png', contentType: 'image/png' })
        .expect(200);
    }
    await api()
      .post(`/api/v1/listings/${id}/photos`)
      .set(...as('owner'))
      .attach('photo', png, { filename: 'p.png', contentType: 'image/png' })
      .expect(201);

    await api()
      .post(`/api/v1/listings/${id}/submit`)
      .set(...as('owner'))
      .expect(200);
    // Not public yet.
    await api().get(`/api/v1/listings/${id}`).expect(404);

    const queue = await api()
      .get('/api/v1/admin/listings')
      .set(...as('admin'))
      .expect(200);
    expect(queue.body.data.items.map((listing) => listing.id)).toEqual([id]);
    await api()
      .post(`/api/v1/admin/listings/${id}/approve`)
      .set(...as('admin'))
      .expect(200);

    // Anyone, signed in or not, now sees it.
    const shown = await api().get(`/api/v1/listings/${id}`).expect(200);
    expect(shown.body.data).toMatchObject({ id, titleAr: 'شقة للبيع في مدينة نصر' });
    expect(shown.body.data.photos).toHaveLength(7);

    const mine = await api()
      .get('/api/v1/listings/mine')
      .set(...as('owner'))
      .expect(200);
    expect(mine.body.data).toMatchObject({ total: 1, items: [{ id, status: 'published' }] });
  });

  it('answers a wrong listing with the fields at fault', async () => {
    const response = await api()
      .post('/api/v1/listings')
      .set(...as('owner'))
      .send(apartmentForSale({ price: -1 }))
      .expect(400);
    expect(response.body).toMatchObject({
      success: false,
      code: 'LISTING_INVALID',
      details: { price: expect.any(String) },
    });
  });

  it('needs a sign-in for everything but browsing', async () => {
    await api().post('/api/v1/listings').send(apartmentForSale()).expect(401);
    await api().get('/api/v1/listings/mine').expect(401);
    await api().get('/api/v1/admin/listings').expect(401);
    await api().get('/api/v1/listings?category=boats').expect(400);
  });

  it('keeps the review to staff and keeps staff from posting', async () => {
    const id = new Types.ObjectId().toString();
    for (const name of ['owner', 'stranger', 'suspended']) {
      await api()
        .get('/api/v1/admin/listings')
        .set(...as(name))
        .expect(403);
      await api()
        .post(`/api/v1/admin/listings/${id}/approve`)
        .set(...as(name))
        .expect(403);
      await api()
        .post(`/api/v1/admin/listings/${id}/reject`)
        .set(...as(name))
        .send({ reason: 'سبب كاف' })
        .expect(403);
    }
    await api()
      .post('/api/v1/listings')
      .set(...as('admin'))
      .send(apartmentForSale())
      .expect(403);
    await api()
      .post(`/api/v1/admin/listings/${id}/reject`)
      .set(...as('admin'))
      .send({})
      .expect(400);
  });

  it('lets a suspended account see and remove its listings but not post or edit', async () => {
    await api()
      .get('/api/v1/listings/mine')
      .set(...as('suspended'))
      .expect(200);
    await api()
      .post('/api/v1/listings')
      .set(...as('suspended'))
      .send(apartmentForSale())
      .expect(403);
    const id = new Types.ObjectId().toString();
    await api()
      .put(`/api/v1/listings/${id}`)
      .set(...as('suspended'))
      .send({ ...apartmentForSale(), version: 1 })
      .expect(403);
    await api()
      .delete(`/api/v1/listings/${id}`)
      .set(...as('suspended'))
      .expect(404);
  });

  it('hides a listing from an account that does not own it', async () => {
    const created = await api()
      .post('/api/v1/listings')
      .set(...as('owner'))
      .send(apartmentForSale())
      .expect(201);
    const { id } = created.body.data.listing;
    await api()
      .get(`/api/v1/listings/mine/${id}`)
      .set(...as('stranger'))
      .expect(404);
    await api()
      .delete(`/api/v1/listings/${id}`)
      .set(...as('stranger'))
      .expect(404);
    await api()
      .put(`/api/v1/listings/${id}/photos/facade`)
      .set(...as('stranger'))
      .attach('photo', png, { filename: 'p.png', contentType: 'image/png' })
      .expect(404);
  });

  it('refuses an upload that does not claim to be an image', async () => {
    const created = await api()
      .post('/api/v1/listings')
      .set(...as('owner'))
      .send(apartmentForSale())
      .expect(201);
    const response = await api()
      .post(`/api/v1/listings/${created.body.data.listing.id}/photos`)
      .set(...as('owner'))
      .attach('photo', Buffer.from('%PDF-1.4'), {
        filename: 'a.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);
    expect(response.body.code).toBe('EVIDENCE_FILE_TYPE_UNSUPPORTED');
  });
});
