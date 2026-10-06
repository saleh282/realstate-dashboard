'use strict';

const { Types } = require('mongoose');
const { ListingsService } = require('../src/services/listings.service');
const { ListingErrorCode } = require('../src/common/errors/listing-error-codes');
const { requiredShots } = require('../src/domain/listings/photo-shots');
const { MAX_OPEN_LISTINGS, MAX_PHOTOS } = require('../src/domain/listings/listing.types');
const { FakeModel, fakeConnection } = require('./support/fake-model');
const { apartmentForSale, shopForRent } = require('./support/listing-fixtures');

const id = () => new Types.ObjectId().toString();
const png = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000000000000000000049454e4400000000',
  'hex',
);
const photoFile = () => ({ buffer: png, mimetype: 'image/png', originalname: 'p.png' });
const videoFile = (bytes = 64) => ({
  buffer: Buffer.concat([Buffer.from('00000018667479706d703432', 'hex'), Buffer.alloc(bytes)]),
  mimetype: 'video/mp4',
  originalname: 'v.mp4',
});

function setup() {
  const owner = {
    _id: new Types.ObjectId(),
    fullName: 'منى أحمد',
    verificationTrustState: 'VERIFIED',
  };
  const listings = new FakeModel();
  const users = new FakeModel([owner]);
  let uploads = 0;
  const assets = {
    uploadListingPhoto: jest.fn(async () => ({
      publicId: `photo-${++uploads}`,
      secureUrl: `https://cdn.example/image/upload/photo-${uploads}.jpg`,
      bytes: 10,
    })),
    uploadListingVideo: jest.fn(async () => ({
      publicId: `video-${++uploads}`,
      secureUrl: `https://cdn.example/video/upload/video-${uploads}.mp4`,
      bytes: 10,
      duration: 30,
    })),
    deleteOrEnqueue: jest.fn().mockResolvedValue(undefined),
  };
  const auditLog = { logRequired: jest.fn().mockResolvedValue(undefined) };
  const outbox = { recordRequired: jest.fn().mockResolvedValue({ eventId: id() }) };
  const now = new Date('2026-10-06T10:00:00Z');
  const service = new ListingsService(
    listings,
    users,
    assets,
    auditLog,
    outbox,
    fakeConnection(),
    () => now,
  );
  const ownerId = owner._id.toString();
  /** A stored listing with every required shot, as far along as `upTo`. */
  const posted = async (upTo = 'draft', data = apartmentForSale()) => {
    let { listing } = await service.create(ownerId, data);
    for (const shot of requiredShots(listing)) {
      ({ listing } = await service.putShot(ownerId, listing.id, shot, photoFile()));
    }
    if (upTo === 'draft') return listing;
    ({ listing } = await service.submit(ownerId, listing.id));
    if (upTo === 'pending_review') return listing;
    if (upTo === 'rejected')
      return (await service.reject(admin, listing.id, 'سعر غير منطقي')).listing;
    return (await service.approve(admin, listing.id)).listing;
  };
  const admin = { userId: id(), ip: '1.1.1.1' };
  return { service, listings, assets, auditLog, outbox, owner, ownerId, posted, admin, now };
}

const rejection = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return { status: error.getStatus(), ...error.getResponse() };
  }
  throw new Error('expected a rejection');
};

describe('posting a listing', () => {
  it('stores a new listing as an unfinished draft of its owner', async () => {
    const { service, ownerId } = setup();
    const { listing } = await service.create(ownerId, apartmentForSale());
    expect(listing).toMatchObject({
      status: 'draft',
      version: 1,
      titleAr: 'شقة للبيع في مدينة نصر',
      latitude: 30.05,
      longitude: 31.33,
      contactPhone: '+201012345678',
      photos: [],
      videoUrl: null,
    });
    expect(listing.missingShots).toEqual(requiredShots({ category: 'residential' }));
  });
  it('refuses wrong data and names each field', async () => {
    const { service, ownerId } = setup();
    expect(
      await rejection(service.create(ownerId, apartmentForSale({ price: 0, titleAr: '' }))),
    ).toMatchObject({
      status: 400,
      code: ListingErrorCode.INVALID,
      details: { price: expect.any(String), titleAr: expect.any(String) },
    });
  });
  it('limits how many open listings an account may have', async () => {
    const { service, ownerId, listings } = setup();
    for (let i = 0; i < MAX_OPEN_LISTINGS; i++) await service.create(ownerId, apartmentForSale());
    expect(await rejection(service.create(ownerId, apartmentForSale()))).toMatchObject({
      status: 409,
      code: ListingErrorCode.LIMIT_REACHED,
    });
    // Closed ones do not count.
    listings.docs[0].status = 'closed';
    await expect(service.create(ownerId, apartmentForSale())).resolves.toBeDefined();
  });
  it('hides the listings of one account from another', async () => {
    const { service, ownerId } = setup();
    const { listing } = await service.create(ownerId, apartmentForSale());
    const stranger = id();
    for (const attempt of [
      service.mineOne(stranger, listing.id),
      service.update(stranger, listing.id, { ...apartmentForSale(), version: 1 }),
      service.submit(stranger, listing.id),
      service.remove(stranger, listing.id),
      service.addPhoto(stranger, listing.id, photoFile()),
    ]) {
      expect(await rejection(attempt)).toMatchObject({
        status: 404,
        code: ListingErrorCode.NOT_FOUND,
      });
    }
    expect((await service.mine(stranger)).items).toEqual([]);
    expect((await service.mine(ownerId)).total).toBe(1);
  });
  it('refuses an id that is not one', async () => {
    const { service, ownerId } = setup();
    expect(await rejection(service.mineOne(ownerId, 'nope'))).toMatchObject({
      status: 400,
      code: ListingErrorCode.ID_INVALID,
    });
  });
});

describe('photos and video', () => {
  it('fills the required shots, the facade first, and replaces a shot taken again', async () => {
    const { service, ownerId, assets } = setup();
    let { listing } = await service.create(ownerId, apartmentForSale());
    ({ listing } = await service.putShot(ownerId, listing.id, 'kitchen', photoFile()));
    ({ listing } = await service.putShot(ownerId, listing.id, 'facade', photoFile()));
    expect(listing.photos.map((photo) => photo.shot)).toEqual(['facade', 'kitchen']);
    expect(listing.missingShots).toEqual(['reception', 'bedroom', 'bathroom', 'view']);

    const old = listing.photos[1];
    ({ listing } = await service.putShot(ownerId, listing.id, 'kitchen', photoFile()));
    expect(listing.photos).toHaveLength(2);
    expect(listing.photos[1].url).not.toBe(old.url);
    expect(assets.deleteOrEnqueue).toHaveBeenLastCalledWith(
      [expect.objectContaining({ publicId: 'photo-1', resourceType: 'image' })],
      'listing-shot-replaced',
    );
  });
  it('refuses a shot the category does not ask for, and a file that is not an image', async () => {
    const { service, ownerId, assets } = setup();
    const { listing } = await service.create(ownerId, apartmentForSale());
    expect(
      await rejection(service.putShot(ownerId, listing.id, 'loading', photoFile())),
    ).toMatchObject({
      status: 400,
      code: ListingErrorCode.SHOT_INVALID,
    });
    const disguised = { buffer: Buffer.from('not an image'), mimetype: 'image/png' };
    expect((await rejection(service.addPhoto(ownerId, listing.id, disguised))).status).toBe(400);
    expect((await rejection(service.addPhoto(ownerId, listing.id, undefined))).status).toBe(400);
    expect(assets.uploadListingPhoto).not.toHaveBeenCalled();
  });
  it('adds extra photos after the shots, reorders and removes them', async () => {
    const { service, ownerId, posted, assets } = setup();
    let listing = await posted();
    for (let i = 0; i < 3; i++)
      ({ listing } = await service.addPhoto(ownerId, listing.id, photoFile()));
    const extras = listing.photos.slice(6).map((photo) => photo.id);
    expect(listing.photos).toHaveLength(9);

    ({ listing } = await service.orderPhotos(ownerId, listing.id, [
      extras[2],
      extras[0],
      extras[1],
    ]));
    expect(listing.photos.slice(6).map((photo) => photo.id)).toEqual([
      extras[2],
      extras[0],
      extras[1],
    ]);
    for (const wrong of [[extras[0]], [...extras, id()], [extras[0], extras[0], extras[1]], 'x']) {
      expect((await rejection(service.orderPhotos(ownerId, listing.id, wrong))).status).toBe(400);
    }

    ({ listing } = await service.removePhoto(ownerId, listing.id, extras[0]));
    expect(listing.photos.slice(6).map((photo) => photo.id)).toEqual([extras[2], extras[1]]);
    expect(assets.deleteOrEnqueue).toHaveBeenLastCalledWith(
      [expect.objectContaining({ resourceType: 'image' })],
      'listing-photo-removed',
    );
    expect(await rejection(service.removePhoto(ownerId, listing.id, extras[0]))).toMatchObject({
      status: 404,
      code: ListingErrorCode.PHOTO_NOT_FOUND,
    });
    // A required shot can only be replaced.
    expect(
      await rejection(service.removePhoto(ownerId, listing.id, listing.photos[0].id)),
    ).toMatchObject({
      status: 409,
      code: ListingErrorCode.STATE_INVALID,
    });
  });
  it('stops at the photo limit and discards the upload that did not fit', async () => {
    const { service, ownerId, posted, assets } = setup();
    let listing = await posted();
    while (listing.photos.length < MAX_PHOTOS) {
      ({ listing } = await service.addPhoto(ownerId, listing.id, photoFile()));
    }
    assets.deleteOrEnqueue.mockClear();
    expect(await rejection(service.addPhoto(ownerId, listing.id, photoFile()))).toMatchObject({
      status: 409,
      code: ListingErrorCode.PHOTO_LIMIT_REACHED,
    });
    expect(assets.deleteOrEnqueue).toHaveBeenCalledWith(
      [expect.objectContaining({ publicId: expect.stringMatching(/^photo-/) })],
      'listing-media-not-saved',
    );
  });
  it('keeps one video, replaces it and removes it', async () => {
    const { service, ownerId, posted, assets } = setup();
    let listing = await posted();
    ({ listing } = await service.putVideo(ownerId, listing.id, videoFile()));
    const first = listing.videoUrl;
    expect(first).toContain('/video/upload/');
    ({ listing } = await service.putVideo(ownerId, listing.id, videoFile()));
    expect(listing.videoUrl).not.toBe(first);
    expect(assets.deleteOrEnqueue).toHaveBeenLastCalledWith(
      [expect.objectContaining({ resourceType: 'video' })],
      'listing-video-replaced',
    );
    ({ listing } = await service.removeVideo(ownerId, listing.id));
    expect(listing.videoUrl).toBeNull();
  });
  it('refuses a video that is too long, too large or not a video', async () => {
    const { service, ownerId, posted, assets } = setup();
    const listing = await posted();
    assets.uploadListingVideo.mockResolvedValueOnce({
      publicId: 'long',
      secureUrl: 'https://cdn.example/video/upload/long.mp4',
      duration: 95,
    });
    expect((await rejection(service.putVideo(ownerId, listing.id, videoFile()))).status).toBe(400);
    expect(assets.deleteOrEnqueue).toHaveBeenLastCalledWith(
      [expect.objectContaining({ publicId: 'long' })],
      'listing-video-too-long',
    );
    assets.uploadListingVideo.mockClear();
    const notVideo = { buffer: Buffer.from('plain text, not a film'), mimetype: 'video/mp4' };
    expect((await rejection(service.putVideo(ownerId, listing.id, notVideo))).status).toBe(400);
    expect(
      (await rejection(service.putVideo(ownerId, listing.id, videoFile(51 * 1024 * 1024)))).status,
    ).toBe(400);
    expect(assets.uploadListingVideo).not.toHaveBeenCalled();
    expect((await service.mineOne(ownerId, listing.id)).videoUrl).toBeNull();
  });
});

describe('the life of a listing', () => {
  it('cannot be sent for review while a required shot is missing', async () => {
    const { service, ownerId } = setup();
    let { listing } = await service.create(ownerId, apartmentForSale());
    ({ listing } = await service.putShot(ownerId, listing.id, 'facade', photoFile()));
    expect(await rejection(service.submit(ownerId, listing.id))).toMatchObject({
      status: 400,
      code: ListingErrorCode.PHOTOS_MISSING,
      details: { missingShots: ['reception', 'bedroom', 'kitchen', 'bathroom', 'view'] },
    });
  });
  it('goes to the review once, with the time it was sent', async () => {
    const { service, ownerId, posted, now } = setup();
    const listing = await posted('pending_review');
    expect(listing).toMatchObject({ status: 'pending_review', submittedAt: now });
    expect(await rejection(service.submit(ownerId, listing.id))).toMatchObject({
      status: 409,
      code: ListingErrorCode.STATE_INVALID,
    });
  });
  it('an edit needs the version it started from', async () => {
    const { service, ownerId, posted } = setup();
    const listing = await posted();
    const edit = (version) =>
      service.update(ownerId, listing.id, { ...apartmentForSale({ price: 2400000 }), version });
    expect(await rejection(edit(undefined))).toMatchObject({ status: 400 });
    expect(await rejection(edit(listing.version - 1))).toMatchObject({
      status: 409,
      code: ListingErrorCode.VERSION_CONFLICT,
    });
    const { listing: saved } = await edit(listing.version);
    expect(saved).toMatchObject({ price: 2400000, version: listing.version + 1, status: 'draft' });
  });
  it('an edit drops what the new data no longer has', async () => {
    const { service, ownerId, posted } = setup();
    const listing = await posted(
      'draft',
      apartmentForSale({ titleEn: 'Apartment for sale', floor: 3 }),
    );
    const { titleEn, floor, ...without } = apartmentForSale();
    const { listing: saved } = await service.update(ownerId, listing.id, {
      ...without,
      version: listing.version,
    });
    expect(saved).not.toHaveProperty('titleEn');
    expect(saved).not.toHaveProperty('floor');
    expect(saved.photos).toHaveLength(6);
  });
  it('a published listing that is edited goes back to the review', async () => {
    const { service, ownerId, posted } = setup();
    const listing = await posted('published');
    expect(listing.status).toBe('published');
    const { listing: edited } = await service.update(ownerId, listing.id, {
      ...apartmentForSale({ price: 2000000 }),
      version: listing.version,
    });
    expect(edited.status).toBe('pending_review');
    // So does one whose photos change.
    const again = await posted('published');
    expect((await service.addPhoto(ownerId, again.id, photoFile())).listing.status).toBe(
      'pending_review',
    );
  });
  it('a refused listing is corrected and sent again, and loses its reason', async () => {
    const { service, ownerId, posted } = setup();
    const listing = await posted('rejected');
    expect(listing).toMatchObject({ status: 'rejected', rejectionReason: 'سعر غير منطقي' });
    const { listing: edited } = await service.update(ownerId, listing.id, {
      ...apartmentForSale({ price: 1900000 }),
      version: listing.version,
    });
    expect(edited).toMatchObject({ status: 'pending_review', rejectionReason: null });
  });
  it('a change of category asks for its own shots before it can be reviewed', async () => {
    const { service, ownerId, posted } = setup();
    const listing = await posted('published');
    const { listing: changed } = await service.update(ownerId, listing.id, {
      ...shopForRent(),
      version: listing.version,
    });
    expect(changed.status).toBe('draft');
    expect(changed.missingShots).toEqual(['entrance', 'interior', 'street']);
    // The photos of shots it no longer asks for are kept as extra photos.
    expect(changed.photos).toHaveLength(6);
  });
  it('is closed by its owner and cannot be changed after', async () => {
    const { service, ownerId, posted, now } = setup();
    const listing = await posted('published');
    const { listing: closed } = await service.close(ownerId, listing.id);
    expect(closed).toMatchObject({ status: 'closed', closedAt: now });
    for (const attempt of [
      service.update(ownerId, listing.id, { ...apartmentForSale(), version: closed.version }),
      service.addPhoto(ownerId, listing.id, photoFile()),
      service.close(ownerId, listing.id),
    ]) {
      expect(await rejection(attempt)).toMatchObject({
        status: 409,
        code: ListingErrorCode.STATE_INVALID,
      });
    }
    const draft = await posted();
    expect((await rejection(service.close(ownerId, draft.id))).status).toBe(409);
  });
  it('is deleted with its photos and video', async () => {
    const { service, ownerId, posted, assets, listings } = setup();
    const listing = await posted();
    await service.putVideo(ownerId, listing.id, videoFile());
    assets.deleteOrEnqueue.mockClear();
    await service.remove(ownerId, listing.id);
    expect(listings.docs).toHaveLength(0);
    const [removed, reason] = assets.deleteOrEnqueue.mock.calls[0];
    expect(reason).toBe('listing-deleted');
    expect(removed.map((asset) => asset.resourceType).sort()).toEqual([
      ...Array(6).fill('image'),
      'video',
    ]);
  });
  it("lists the owner's listings by status, newest change first", async () => {
    const { service, ownerId, posted } = setup();
    await posted('draft');
    await posted('pending_review');
    await posted('published');
    expect((await service.mine(ownerId)).total).toBe(3);
    const pending = await service.mine(ownerId, { status: 'pending_review' });
    expect(pending.items.map((listing) => listing.status)).toEqual(['pending_review']);
    expect((await service.mine(ownerId, { limit: '2' })).items).toHaveLength(2);
    expect((await rejection(service.mine(ownerId, { status: 'nope' }))).status).toBe(400);
  });
});

describe('what everyone sees', () => {
  it('shows a listing only while it is published', async () => {
    const { service, ownerId, posted } = setup();
    for (const status of ['draft', 'pending_review', 'rejected']) {
      const hidden = await posted(status);
      expect(await rejection(service.publicOne(hidden.id))).toMatchObject({ status: 404 });
    }
    const listing = await posted('published');
    const shown = await service.publicOne(listing.id);
    expect(shown).toMatchObject({
      id: listing.id,
      advertiser: { name: 'منى أحمد', verified: true, photoUrl: null },
    });
    for (const secret of ['status', 'version', 'rejectionReason', 'owner', 'missingShots']) {
      expect(shown).not.toHaveProperty(secret);
    }
    await service.close(ownerId, listing.id);
    expect((await rejection(service.publicOne(listing.id))).status).toBe(404);
  });
  it('searches published listings through the search pipeline and counts them', async () => {
    const { service, listings, owner } = setup();
    listings.aggregateResult = [
      {
        total: [{ count: 41 }],
        items: [
          {
            _id: new Types.ObjectId(),
            ...apartmentForSale(),
            location: { type: 'Point', coordinates: [31.33, 30.05] },
            photos: [],
            owner,
            distanceMeters: 1234,
          },
        ],
      },
    ];
    const result = await service.search({ category: 'residential', page: '2', limit: '10' });
    expect(result).toMatchObject({ page: 2, limit: 10, total: 41 });
    expect(result.items[0]).toMatchObject({ distanceKm: 1.2, advertiser: { verified: true } });
    expect(listings.aggregated[0][0]).toEqual({
      $match: { status: 'published', category: 'residential' },
    });
    listings.aggregateResult = [{ total: [], items: [] }];
    expect(await service.search({})).toMatchObject({ items: [], total: 0 });
  });
  it('refuses a search it cannot understand', async () => {
    const { service } = setup();
    expect(await rejection(service.search({ minPrice: 'cheap', sort: 'nearest' }))).toMatchObject({
      status: 400,
      code: ListingErrorCode.QUERY_INVALID,
      details: { minPrice: expect.any(String), near: expect.any(String) },
    });
  });
  it('gives the map light markers and needs its bounds', async () => {
    const { service, posted } = setup();
    await posted('published');
    await posted('pending_review');
    expect((await rejection(service.map({}))).status).toBe(400);
    // The in-memory model cannot answer a geo query, so only the request is checked here.
    await expect(service.map({ bbox: '29,30,31,32' })).rejects.toThrow('unsupported operator');
  });
});

describe('the review', () => {
  it('queues what waits, oldest first, with who posted it', async () => {
    const { service, posted, listings } = setup();
    const first = await posted('pending_review');
    const second = await posted('pending_review');
    await posted('draft');
    listings.docs.find((doc) => String(doc._id) === second.id).submittedAt = new Date('2026-10-01');
    const queue = await service.reviewQueue();
    expect(queue.total).toBe(2);
    expect(queue.items.map((listing) => listing.id)).toEqual([second.id, first.id]);
    expect(queue.items[0].owner).toMatchObject({ name: 'منى أحمد', verified: true });
    expect((await rejection(service.reviewQueue({ status: 'draft' }))).status).toBe(400);
    expect((await service.reviewQueue({ status: 'published' })).total).toBe(0);
  });
  it('never shows an unfinished draft', async () => {
    const { service, posted } = setup();
    const draft = await posted('draft');
    expect((await rejection(service.reviewOne(draft.id))).status).toBe(404);
    expect((await rejection(service.approve({ userId: id() }, draft.id))).status).toBe(404);
    const waiting = await posted('pending_review');
    expect((await service.reviewOne(waiting.id)).status).toBe('pending_review');
  });
  it('approval publishes it, records who decided and tells the advertiser', async () => {
    const { service, posted, admin, auditLog, outbox, ownerId, now } = setup();
    const waiting = await posted('pending_review');
    const { listing } = await service.approve(admin, waiting.id);
    expect(listing).toMatchObject({ status: 'published', publishedAt: now, reviewedAt: now });
    expect(auditLog.logRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'listing_approved',
        actorUserId: admin.userId,
        targetUserId: ownerId,
        targetResourceId: waiting.id,
        ip: '1.1.1.1',
      }),
      expect.anything(),
    );
    expect(outbox.recordRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'LISTING_APPROVED',
        aggregateId: waiting.id,
        privateRouting: { advertiserAccountId: ownerId },
      }),
      expect.anything(),
    );
    expect((await service.publicOne(waiting.id)).id).toBe(waiting.id);
  });
  it('refusal needs a reason and keeps it for the advertiser only', async () => {
    const { service, posted, admin, outbox, ownerId } = setup();
    const waiting = await posted('pending_review');
    for (const reason of [undefined, '', '  ', 'لا', 'x'.repeat(501)]) {
      expect(await rejection(service.reject(admin, waiting.id, reason))).toMatchObject({
        status: 400,
        code: ListingErrorCode.REASON_REQUIRED,
      });
    }
    const { listing } = await service.reject(admin, waiting.id, '  الصور غير واضحة  ');
    expect(listing).toMatchObject({ status: 'rejected', rejectionReason: 'الصور غير واضحة' });
    expect((await service.mineOne(ownerId, waiting.id)).rejectionReason).toBe('الصور غير واضحة');
    const event = outbox.recordRequired.mock.calls.at(-1)[0];
    expect(event.type).toBe('LISTING_REJECTED');
    expect(JSON.stringify(event)).not.toContain('الصور');
  });
  it('a listing is decided once', async () => {
    const { service, posted, admin, auditLog } = setup();
    const waiting = await posted('pending_review');
    await service.approve(admin, waiting.id);
    auditLog.logRequired.mockClear();
    for (const attempt of [
      service.approve(admin, waiting.id),
      service.reject(admin, waiting.id, 'سبب كاف'),
    ]) {
      expect(await rejection(attempt)).toMatchObject({
        status: 409,
        code: ListingErrorCode.STATE_INVALID,
      });
    }
    expect(auditLog.logRequired).not.toHaveBeenCalled();
  });
});
