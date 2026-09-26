import { BadRequestException, CanActivate, ExecutionContext, HttpException, INestApplication, UnauthorizedException } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/app.setup';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { SystemRole } from '../src/auth/roles.enum';
import { PropertyErrorCode } from '../src/common/errors/property-error-codes';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { PropertiesController } from '../src/properties/properties.controller';
import { PropertiesService } from '../src/properties/properties.service';
import { PropertyMarketingMode } from '../src/properties/property.types';
import { AccountType, BrokerStatus } from '../src/users/identity.types';
import { FormDefinitionStore } from './support/form-definition-store';

/**
 * DPF-003 — photo-slot validation data travels under the standard `details`
 * object, so it survives the global exception filter, whose exposed-key
 * allowlist is left unchanged.
 */

const userId = '64b000000000000000000001';
const categoryId = '64b000000000000000000010';
const subcategoryId = '64b000000000000000000011';
const requiredPhotoSlots = ['exterior', 'entrance', 'living_1', 'bedroom_1', 'bedroom_2', 'bedroom_3', 'kitchen_1', 'bathroom_1', 'bathroom_2'];
const validPng = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000000000000000000049454e4400000000', 'hex');
const MISSING_MESSAGE = 'يجب استكمال جميع فئات صور العقار المطلوبة';
const DUPLICATE_MESSAGE = 'يجب استخدام صورة مستقلة لكل قسم مطلوب';
const SUBMIT_MISSING_MESSAGE = 'لا يمكن نشر العقار قبل استكمال صور العرض المطلوبة';
const ENVELOPE_KEYS = ['code', 'details', 'message', 'requestId', 'success'];

const query = (value: unknown) => {
  const chain: any = { lean: () => ({ exec: jest.fn().mockResolvedValue(value) }) };
  chain.populate = () => chain;
  return chain;
};

// The real PropertiesService producers, with catalog lookups faked the same way as properties.spec.ts
// and just enough persistence for a draft save to complete.
const matched = (count: number) => ({ exec: jest.fn().mockResolvedValue({ matchedCount: count }) });
const createdRevisions: any[] = [];
function realPropertiesService() {
  const instance = Object.create(PropertiesService.prototype) as any;
  const session = { withTransaction: jest.fn(async (work: () => Promise<void>) => work()), endSession: jest.fn() };
  Object.assign(instance, {
    users: { find: jest.fn().mockReturnValue(query([{ _id: { toString: () => userId }, systemRole: 'USER', accountType: AccountType.USER, accountStatus: 'ACTIVE' }])) },
    purposeCategories: { findOne: jest.fn().mockReturnValue(query({ _id: { toString: () => categoryId } })), updateOne: jest.fn(() => matched(1)) },
    propertyTypes: { findOne: jest.fn().mockReturnValue(query({ _id: { toString: () => subcategoryId }, code: 'apartment', purposeCategoryId: { toString: () => categoryId } })), updateMany: jest.fn(() => matched(1)) },
    governorates: { findOne: jest.fn().mockReturnValue(query({ code: 'cairo' })), updateOne: jest.fn(() => matched(1)) },
    cities: { findOne: jest.fn().mockReturnValue(query({ _id: '64b000000000000000000020', nameAr: 'القاهرة' })), updateOne: jest.fn(() => matched(1)) },
    options: { findOne: jest.fn().mockReturnValue(query({ code: 'valid' })), find: jest.fn().mockReturnValue(query([{ code: 'cash' }])), updateMany: jest.fn(() => matched(3)) },
    amenities: { countDocuments: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(1) }), updateMany: jest.fn(() => matched(1)) },
    auctionLock: { assertUnlocked: jest.fn().mockResolvedValue(undefined) },
    ...new FormDefinitionStore().models(),
    properties: { create: jest.fn(async ([value]: any[]) => [{ ...value, toObject: () => ({ ...value, createdAt: new Date() }) }]), deleteOne: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(undefined) })) },
    revisions: { create: jest.fn(async ([value]: any[]) => { createdRevisions.push(value); return [value]; }), deleteOne: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(undefined) })) },
    connection: { startSession: jest.fn().mockResolvedValue(session) },
    audit: { logRequired: jest.fn(), logResourceAction: jest.fn(), logAdminResourceAction: jest.fn() },
    evidenceAssets: {
      uploadPublicPropertyMedia: jest.fn(async () => ({ publicId: 'photo', secureUrl: 'https://cdn.example/photo.png', resourceType: 'image', deliveryType: 'upload', format: 'png', bytes: validPng.length })),
      deleteOrEnqueue: jest.fn(),
    },
  });
  return instance as PropertiesService;
}

class TestJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp().getRequest();
    if (!http.headers.authorization) throw new UnauthorizedException();
    http.user = { userId, systemRole: SystemRole.USER, accountStatus: 'active', accountType: AccountType.USER, brokerStatus: BrokerStatus.NOT_APPLIED };
    return true;
  }
}

describe('DPF-003 photo-slot error details over HTTP (POST /properties)', () => {
  let app: INestApplication;
  let service: PropertiesService;

  beforeAll(async () => {
    service = realPropertiesService();
    const moduleRef = await Test.createTestingModule({
      controllers: [PropertiesController],
      providers: [{ provide: PropertiesService, useValue: service }],
    }).overrideGuard(JwtAuthGuard).useClass(TestJwtAuthGuard).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' });
    await app.init();
  });
  afterAll(() => app.close());

  const fields: Record<string, string> = {
    operationType: 'sale', purposeCategoryId: categoryId, purposeSubcategoryId: subcategoryId, title: 'شقة ممتازة للبيع',
    description: 'وصف تفصيلي صالح للعقار المعروض للبيع', governorateCode: 'cairo', city: 'القاهرة', district: 'التجمع',
    latitude: '30', longitude: '31', area: '150', bedrooms: '3', livingRooms: '1', kitchens: '1', bathrooms: '2', floor: '2',
    totalFloors: '5', buildingYear: '2020', finishingStatusCode: 'fully_finished', deliveryStatusCode: 'immediate',
    amenityCodes: '["elevator"]', totalPriceMinor: '100000000', currency: 'EGP', isPriceNegotiable: 'true',
    paymentMethodCodes: '["cash"]', marketingMode: PropertyMarketingMode.SELF_SERVICE, coverImageIndex: '0', hidePhone: 'false',
  };

  const createWithSlots = (slotIds: string[], content: (index: number) => Buffer = (index) => Buffer.concat([validPng, Buffer.from([index])])) => {
    let req = request(app.getHttpServer()).post('/api/v1/properties').set('Authorization', 'Bearer user');
    for (const [key, value] of Object.entries({ ...fields, imageLabels: JSON.stringify(slotIds), imageSlotIds: JSON.stringify(slotIds) })) req = req.field(key, value);
    slotIds.forEach((slotId, index) => { req = req.attach('images', content(index), { filename: `${slotId}.png`, contentType: 'image/png' }); });
    return req;
  };

  const expectEnvelope = (res: request.Response, code: string, message: string, details: Record<string, unknown>) => {
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, message, code, details, requestId: expect.any(String) });
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
    // No slot data as ad-hoc top-level properties.
    expect(Object.keys(res.body).sort()).toEqual(ENVELOPE_KEYS);
    for (const key of ['missingPhotoSlots', 'invalidPhotoSlots', 'duplicatePhotoSlots']) expect(res.body).not.toHaveProperty(key);
  };

  it('saves a draft that is only missing required slots (DPF-022: completeness is enforced at submit)', async () => {
    const res = await createWithSlots(requiredPhotoSlots.filter((slot) => slot !== 'bathroom_2'));
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(createdRevisions.at(-1).galleryMedia.map((asset: any) => asset.slotId)).toEqual(requiredPhotoSlots.filter((slot) => slot !== 'bathroom_2'));
  });

  it('returns unknown photo slots under details.invalidPhotoSlots', async () => {
    const res = await createWithSlots([...requiredPhotoSlots, 'garage_1']);
    expectEnvelope(res, 'PROPERTY_REQUIRED_PHOTO_SLOTS_MISSING', MISSING_MESSAGE, { missingPhotoSlots: [], invalidPhotoSlots: ['garage_1'] });
  });

  it('returns both missing and invalid slots together when both occur', async () => {
    const res = await createWithSlots([...requiredPhotoSlots.filter((slot) => slot !== 'kitchen_1'), 'roof_1']);
    expectEnvelope(res, 'PROPERTY_REQUIRED_PHOTO_SLOTS_MISSING', MISSING_MESSAGE, { missingPhotoSlots: ['kitchen_1'], invalidPhotoSlots: ['roof_1'] });
  });

  it('returns reused required-slot photos under details.duplicatePhotoSlots', async () => {
    const res = await createWithSlots(requiredPhotoSlots, (index) => (index === 1 ? Buffer.concat([validPng, Buffer.from([0])]) : Buffer.concat([validPng, Buffer.from([index])])));
    expectEnvelope(res, 'PROPERTY_PHOTO_SLOT_MEDIA_DUPLICATED', DUPLICATE_MESSAGE, { duplicatePhotoSlots: ['exterior', 'entrance'] });
  });
});

describe('DPF-003 photo-slot error details through the global exception filter', () => {
  function fakeHost() {
    const response = { headersSent: false, setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
    const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ method: 'POST', originalUrl: '/api/v1/properties', headers: {}, requestId: 'req-dpf-003' }) }) } as any;
    return { host, response };
  }
  const filter = new HttpExceptionFilter({ error: jest.fn(), warn: jest.fn() });
  const render = (exception: unknown) => {
    const { host, response } = fakeHost();
    filter.catch(exception, host);
    return { status: response.status.mock.calls[0][0], body: response.json.mock.calls[0][0] };
  };
  const thrown = (work: () => unknown) => {
    try { work(); } catch (error) { return error as HttpException; }
    throw new Error('expected the producer to throw');
  };

  it('keeps missing presentation slots from submission/approval validation under details.missingPhotoSlots', () => {
    const exception = thrown(() => (realPropertiesService() as any).assertPresentationMediaComplete({
      marketingMode: PropertyMarketingMode.SELF_SERVICE, livingRooms: 1, bedrooms: 1, kitchens: 1, bathrooms: 1,
      galleryMedia: ['exterior', 'entrance', 'living_1', 'bedroom_1', 'kitchen_1'].map((slotId) => ({ slotId })),
    }));
    expect(exception).toBeInstanceOf(BadRequestException);
    expect(exception.getResponse()).toEqual({ message: SUBMIT_MISSING_MESSAGE, code: PropertyErrorCode.REQUIRED_PHOTO_SLOTS_MISSING, details: { missingPhotoSlots: ['bathroom_1'] } });
    expect(render(exception)).toEqual({
      status: 400,
      body: { success: false, message: SUBMIT_MISSING_MESSAGE, code: PropertyErrorCode.REQUIRED_PHOTO_SLOTS_MISSING, details: { missingPhotoSlots: ['bathroom_1'] }, requestId: 'req-dpf-003' },
    });
  });

  it('drops slot data thrown as ad-hoc top-level properties (the pre-DPF-003 shape never reached clients)', () => {
    const { body } = render(new BadRequestException({
      message: MISSING_MESSAGE, code: PropertyErrorCode.REQUIRED_PHOTO_SLOTS_MISSING, missingPhotoSlots: ['bathroom_1'], invalidPhotoSlots: ['garage_1'],
    }));
    expect(body).toEqual({ success: false, message: MISSING_MESSAGE, code: PropertyErrorCode.REQUIRED_PHOTO_SLOTS_MISSING, requestId: 'req-dpf-003' });
  });

  it('still strips every non-allowlisted top-level property, exposing only the unchanged allowlist', () => {
    const allowlisted = {
      code: 'X', isVerified: false, requiresVerification: true, otpSent: false, identifier: 'id', expiresInMinutes: 5,
      retryAfterSeconds: 30, details: { missingPhotoSlots: ['exterior'] }, deletion: { state: 's' }, blockers: ['b'],
    };
    const { body } = render(new BadRequestException({
      message: 'm', ...allowlisted,
      duplicatePhotoSlots: ['exterior'], stack: 'at secret.ts:1', internalNote: 'do not leak', password: 'hunter2', user: { email: 'x@example.com' },
    }));
    expect(body).toEqual({ success: false, message: 'm', ...allowlisted, requestId: 'req-dpf-003' });
    expect(JSON.stringify(body)).not.toMatch(/hunter2|do not leak|secret\.ts|x@example\.com/);
  });

  it('adds no generic pass-through: an exception without details exposes no details key', () => {
    const { body } = render(new BadRequestException({ message: DUPLICATE_MESSAGE, code: 'PROPERTY_PHOTO_SLOT_MEDIA_DUPLICATED' }));
    expect(body).toEqual({ success: false, message: DUPLICATE_MESSAGE, code: 'PROPERTY_PHOTO_SLOT_MEDIA_DUPLICATED', requestId: 'req-dpf-003' });
  });
});
