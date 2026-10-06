'use strict';

const request = require('supertest');
const { Types } = require('mongoose');
const { httpApp } = require('./support/http-app');
const { FakeModel } = require('./support/fake-model');
const { FavouritesService, MAX_FAVOURITES } = require('../src/services/favourites.service');
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
  const listing = (status) => ({ _id: id(), status });
  const docs = {
    first: listing('published'),
    second: listing('published'),
    pending: listing('pending_review'),
  };
  const favourites = new FakeModel();
  const listings = new FakeModel(Object.values(docs));
  const service = new FavouritesService(favourites, listings);
  const ids = Object.fromEntries(
    Object.entries(docs).map(([name, doc]) => [name, String(doc._id)]),
  );
  return { service, favourites, listings, ids, user: String(id()), other: String(id()) };
}

describe('favourites', () => {
  it('keeps what an account marked, newest first, and nothing twice', async () => {
    const { service, favourites, ids, user } = setup();
    await service.add(user, ids.first);
    await service.add(user, ids.second);
    await service.add(user, ids.first);
    favourites.docs.forEach((doc, index) => (doc.createdAt = new Date(2026, 9, 1 + index)));
    expect(favourites.docs).toHaveLength(2);
    expect(await service.list(user)).toEqual({ ids: [ids.second, ids.first] });
  });
  it('keeps each account to its own', async () => {
    const { service, ids, user, other } = setup();
    await service.add(user, ids.first);
    expect(await service.list(other)).toEqual({ ids: [] });
    await service.remove(other, ids.first);
    expect((await service.list(user)).ids).toEqual([ids.first]);
  });
  it('only marks a published listing', async () => {
    const { service, ids, user } = setup();
    for (const listingId of [ids.pending, String(id())]) {
      expect(await rejection(service.add(user, listingId))).toMatchObject({
        status: 404,
        code: ListingErrorCode.NOT_FOUND,
      });
    }
    expect((await rejection(service.add(user, 'nope'))).status).toBe(400);
  });
  it('hides a favourite while its listing is not published, and shows it again after', async () => {
    const { service, listings, ids, user } = setup();
    await service.add(user, ids.first);
    await service.add(user, ids.second);
    const doc = listings.docs.find((listing) => String(listing._id) === ids.first);
    doc.status = 'rejected';
    expect((await service.list(user)).ids).toEqual([ids.second]);
    doc.status = 'published';
    expect((await service.list(user)).ids).toHaveLength(2);
  });
  it('unmarks, also what is gone, and as often as asked', async () => {
    const { service, listings, ids, user } = setup();
    await service.add(user, ids.first);
    listings.docs.length = 0;
    await service.remove(user, ids.first);
    await service.remove(user, ids.first);
    expect(await service.list(user)).toEqual({ ids: [] });
    expect((await rejection(service.remove(user, 'nope'))).status).toBe(400);
  });
  it('stops at its limit', async () => {
    const { service, favourites, ids, user } = setup();
    for (let i = 0; i < MAX_FAVOURITES; i++) {
      favourites.docs.push({ _id: id(), userId: new Types.ObjectId(user), listingId: id() });
    }
    expect(await rejection(service.add(user, ids.first))).toMatchObject({
      status: 409,
      code: ListingErrorCode.LIMIT_REACHED,
    });
  });
});

describe('favourites over HTTP', () => {
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
    app = httpApp(
      { FavouritesService: context.service },
      (target, provided) =>
        target.use(
          '/api/v1/favourites',
          require('../src/routes/favourites.routes').createRouter(provided),
        ),
      async (req) => {
        req.user = accounts[req.headers.authorization.replace('Bearer ', '')];
      },
    );
    await app.init();
  });
  afterAll(async () => app.close());

  it('marks, lists and unmarks', async () => {
    await api()
      .put(`/api/v1/favourites/${ids.first}`)
      .set(...as('user'))
      .expect(200);
    const listed = await api()
      .get('/api/v1/favourites')
      .set(...as('user'))
      .expect(200);
    expect(listed.body.data).toEqual({ ids: [ids.first] });
    await api()
      .delete(`/api/v1/favourites/${ids.first}`)
      .set(...as('user'))
      .expect(200);
    await api()
      .put(`/api/v1/favourites/${ids.pending}`)
      .set(...as('user'))
      .expect(404);
  });
  it('needs a sign-in, lets a suspended account in and keeps staff out', async () => {
    await api().get('/api/v1/favourites').expect(401);
    await api().put(`/api/v1/favourites/${ids.first}`).expect(401);
    await api()
      .get('/api/v1/favourites')
      .set(...as('suspended'))
      .expect(200);
    await api()
      .get('/api/v1/favourites')
      .set(...as('admin'))
      .expect(403);
  });
});
