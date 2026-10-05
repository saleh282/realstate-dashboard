'use strict';
const { httpApp } = require('./support/http-app');
const { UnauthorizedException } = require('../src/common/http/errors');
const { ValidationPipe } = require('../src/middleware/validate');
const request = require('supertest');

const { AdminKycController } = require('../src/controllers/admin-kyc.controller');
const { AdminUsersController } = require('../src/controllers/admin-users.controller');
const { AdminDashboardController } = require('../src/controllers/admin-dashboard.controller');
const { AdminAuditController } = require('../src/controllers/admin-audit.controller');
const { AuditLogService } = require('../src/services/audit-log.service');
const { UserRole } = require('../src/domain/auth/roles.enum');
const { CloudinaryAssetService } = require('../src/services/cloudinary-asset.service');
const { UsersService } = require('../src/services/users.service');
const { AdminPropertiesController } = require('../src/controllers/admin-properties.controller');
const { PropertiesController } = require('../src/controllers/properties.controller');
const { PropertiesService } = require('../src/services/properties.service');
const {
  AdminBrokerApplicationsController,
} = require('../src/controllers/admin-broker-applications.controller');
const {
  BrokerApplicationsController,
} = require('../src/controllers/broker-applications.controller');
const { BrokerApplicationsService } = require('../src/services/broker-applications.service');
const { AdminCompaniesController } = require('../src/controllers/admin-companies.controller');
const { CompanyAccountsService } = require('../src/services/company-accounts.service');
const { AccountDeletionService } = require('../src/services/account-deletion.service');
class TestJwtAuthGuard {
  canActivate(context) {
    const httpRequest = context.switchToHttp().getRequest();
    const authorization = httpRequest.headers.authorization;
    if (!authorization) throw new UnauthorizedException();
    httpRequest.user = {
      userId: '64b000000000000000000001',
      systemRole:
        authorization === 'Bearer admin'
          ? UserRole.ADMIN
          : authorization === 'Bearer super-admin'
            ? UserRole.SUPER_ADMIN
            : UserRole.USER,
    };
    return true;
  }
}
describe('admin controller authorization', () => {
  let app;
  const usersService = {
    listForAdmin: jest.fn().mockResolvedValue({ items: [], pagination: {} }),
    listKycForAdmin: jest.fn().mockResolvedValue({ items: [], pagination: {} }),
    getDashboardMetricsForAdmin: jest.fn().mockResolvedValue({ users: {}, kyc: {} }),
    getKycAssetForAdmin: jest.fn().mockResolvedValue({ publicId: 'front' }),
    reviewKycForAdmin: jest.fn().mockResolvedValue({
      userId: '64b000000000000000000002',
      kycStatus: 'verified',
      kycVersion: 2,
    }),
  };
  const auditLogService = {
    listForAdmin: jest.fn().mockResolvedValue({ items: [], pagination: {} }),
  };
  const cloudinaryAssetService = {
    downloadAuthenticatedAsset: jest.fn().mockResolvedValue({
      buffer: Buffer.from([0xff, 0xd8, 0xff]),
      contentType: 'image/jpeg',
    }),
  };
  const propertiesService = {
    downloadTitleDeedForOwner: jest
      .fn()
      .mockResolvedValue({ buffer: Buffer.from('%PDF'), contentType: 'application/pdf' }),
    downloadTitleDeedForAdmin: jest
      .fn()
      .mockResolvedValue({ buffer: Buffer.from('%PDF'), contentType: 'application/pdf' }),
    downloadPrivateEvidenceForOwner: jest
      .fn()
      .mockResolvedValue({ buffer: Buffer.from('%PDF'), contentType: 'application/pdf' }),
    downloadPrivateEvidenceForAdmin: jest
      .fn()
      .mockResolvedValue({ buffer: Buffer.from('%PDF'), contentType: 'application/pdf' }),
  };
  const brokerApplicationsService = {
    listOwnApplications: jest.fn().mockResolvedValue({ items: [] }),
    reviewApplication: jest.fn().mockResolvedValue({
      application: { status: 'APPROVED', version: 1 },
      account: { accountType: 'BROKER', brokerStatus: 'APPROVED' },
    }),
  };
  const companyAccountsService = {
    create: jest.fn().mockResolvedValue({
      account: {
        userId: '64b000000000000000000004',
        systemRole: 'USER',
        accountType: 'COMPANY',
      },
    }),
  };
  const accountDeletionService = {
    requestDeletionForAdmin: jest.fn(),
    getAdminImpact: jest.fn().mockResolvedValue({
      workflow: null,
      history: [],
      impact: { blockers: [], finalPurgeEnabled: false },
    }),
    setLegalHold: jest.fn(),
    anonymize: jest.fn(),
  };
  beforeAll(async () => {
    const moduleRef = await (() => {
      const services = {};
      services.UsersService = usersService;
      services.AccountDeletionService = accountDeletionService;
      services.CloudinaryAssetService = cloudinaryAssetService;
      services.AuditLogService = auditLogService;
      services.PropertiesService = propertiesService;
      services.BrokerApplicationsService = brokerApplicationsService;
      services.CompanyAccountsService = companyAccountsService;
      return {
        services,
        app: httpApp(
          services,
          (app, services) => {
            app.use(
              '/api/v1/admin/users',
              require('../src/routes/admin-users.routes').createRouter(services),
            );
            app.use(
              '/api/v1/admin/kyc',
              require('../src/routes/admin-kyc.routes').createRouter(services),
            );
            app.use(
              '/api/v1/admin/dashboard',
              require('../src/routes/admin-dashboard.routes').createRouter(services),
            );
            app.use(
              '/api/v1/admin/audit-logs',
              require('../src/routes/admin-audit.routes').createRouter(services),
            );
            app.use(
              '/api/v1/admin/properties',
              require('../src/routes/admin-properties.routes').createRouter(services),
            );
            app.use(
              '/api/v1/properties',
              require('../src/routes/properties.routes').createRouter(services),
            );
            app.use(
              '/api/v1/admin',
              require('../src/routes/admin-broker-applications.routes').createRouter(services),
            );
            app.use(
              '/api/v1/broker',
              require('../src/routes/broker-applications.routes').createRouter(services),
            );
            app.use(
              '/api/v1/admin/companies',
              require('../src/routes/admin-companies.routes').createRouter(services),
            );
          },
          (req) =>
            new TestJwtAuthGuard().canActivate({ switchToHttp: () => ({ getRequest: () => req }) }),
        ),
      };
    })();
    app = moduleRef.app;

    await app.init();
  });
  afterAll(async () => app.close());
  it('returns 401 for an unauthenticated admin route request', () =>
    request(app.getHttpServer()).get('/api/v1/admin/users').expect(401));
  it('returns 403 for a normal user', () =>
    request(app.getHttpServer())
      .get('/api/v1/admin/users')
      .set('Authorization', 'Bearer user')
      .expect(403));
  it('allows an administrator', () =>
    request(app.getHttpServer())
      .get('/api/v1/admin/users')
      .set('Authorization', 'Bearer admin')
      .expect(200));
  it('allows SUPER_ADMIN through ADMIN-guarded operational routes', () =>
    request(app.getHttpServer())
      .get('/api/v1/admin/users')
      .set('Authorization', 'Bearer super-admin')
      .expect(200));
  it('denies an ADMIN access to the SUPER_ADMIN-only role command', () =>
    request(app.getHttpServer())
      .patch('/api/v1/admin/users/64b000000000000000000002/role')
      .set('Authorization', 'Bearer admin')
      .send({ systemRole: 'ADMIN', reason: 'privileged role update test' })
      .expect(403));
  it('allows only ADMIN/SUPER_ADMIN to create a COMPANY account', async () => {
    const payload = {
      fullName: 'Company Account',
      email: 'company@example.com',
      initialPassword: 'CompanyPass123!',
    };
    await request(app.getHttpServer()).post('/api/v1/admin/companies').send(payload).expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/admin/companies')
      .set('Authorization', 'Bearer user')
      .send(payload)
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/admin/companies')
      .set('Authorization', 'Bearer admin')
      .send(payload)
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/admin/companies')
      .set('Authorization', 'Bearer super-admin')
      .send({ ...payload, email: 'second-company@example.com' })
      .expect(201);
    expect(companyAccountsService.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'company@example.com' }),
      expect.objectContaining({
        actorUserId: '64b000000000000000000001',
        requestId: expect.any(String),
      }),
    );
  });
  it.each(['/api/v1/admin/kyc', '/api/v1/admin/dashboard/metrics', '/api/v1/admin/audit-logs'])(
    'enforces admin role on %s',
    async (path) => {
      await request(app.getHttpServer()).get(path).set('Authorization', 'Bearer user').expect(403);
      await request(app.getHttpServer()).get(path).set('Authorization', 'Bearer admin').expect(200);
    },
  );
  it('prevents unauthenticated and marketplace users from uploading platform property media', async () => {
    const path =
      '/api/v1/admin/properties/64b000000000000000000090/revisions/64b000000000000000000091/media';
    await request(app.getHttpServer()).post(path).expect(401);
    await request(app.getHttpServer())
      .post(path)
      .set('Authorization', 'Bearer user')
      .field('tagCode', 'exterior')
      .field('version', '0')
      .attach('image', Buffer.from([0xff, 0xd8, 0xff]), {
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
      })
      .expect(403);
  });
  it('requires authentication for a broker applicant history', async () => {
    await request(app.getHttpServer()).get('/api/v1/broker/applications/me').expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/broker/applications/me')
      .set('Authorization', 'Bearer user')
      .expect(200);
  });
  it('allows only ADMIN/SUPER_ADMIN to decide a broker application', async () => {
    const path = '/api/v1/admin/broker/applications/64b000000000000000000003/review';
    const payload = { decision: 'APPROVED', expectedVersion: 0 };
    await request(app.getHttpServer()).post(path).send(payload).expect(401);
    await request(app.getHttpServer())
      .post(path)
      .set('Authorization', 'Bearer user')
      .send(payload)
      .expect(403);
    await request(app.getHttpServer())
      .post(path)
      .set('Authorization', 'Bearer admin')
      .send(payload)
      .expect(201);
    expect(brokerApplicationsService.reviewApplication).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationId: '64b000000000000000000003',
        decision: 'APPROVED',
        expectedVersion: 0,
      }),
    );
  });
  it('protects and streams KYC documents only to an administrator', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/kyc/64b000000000000000000002/documents/id-front')
      .set('Authorization', 'Bearer user')
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/admin/kyc/64b000000000000000000002/documents/id-front')
      .set('Authorization', 'Bearer admin')
      .expect('Content-Type', 'image/jpeg')
      .expect('Cache-Control', 'private, no-store, max-age=0')
      .expect(200);
  });
  it('protects property evidence for the owner and administrative review', async () => {
    const ownerPath = '/api/v1/properties/mine/64b000000000000000000099/evidence/title-deed';
    await request(app.getHttpServer()).get(ownerPath).expect(401);
    await request(app.getHttpServer())
      .get(ownerPath)
      .set('Authorization', 'Bearer user')
      .expect('Cache-Control', 'private, no-store, max-age=0')
      .expect(200);
    const adminPath = '/api/v1/admin/properties/64b000000000000000000099/evidence/title-deed';
    await request(app.getHttpServer())
      .get(adminPath)
      .set('Authorization', 'Bearer user')
      .expect(403);
    await request(app.getHttpServer())
      .get(adminPath)
      .set('Authorization', 'Bearer admin')
      .expect('Cache-Control', 'private, no-store, max-age=0')
      .expect(200);
  });
  it('protects revision-scoped private evidence and emits no-store headers', async () => {
    const suffix = '64b000000000000000000099/revisions/64b000000000000000000088/evidence/0';
    const ownerPath = `/api/v1/properties/mine/${suffix}`;
    const adminPath = `/api/v1/admin/properties/${suffix}`;
    await request(app.getHttpServer()).get(ownerPath).expect(401);
    await request(app.getHttpServer())
      .get(ownerPath)
      .set('Authorization', 'Bearer user')
      .expect('Cache-Control', 'private, no-store, max-age=0')
      .expect('X-Content-Type-Options', 'nosniff')
      .expect(200);
    await request(app.getHttpServer())
      .get(adminPath)
      .set('Authorization', 'Bearer user')
      .expect(403);
    await request(app.getHttpServer())
      .get(adminPath)
      .set('Authorization', 'Bearer admin')
      .expect('Cache-Control', 'private, no-store, max-age=0')
      .expect('X-Content-Type-Options', 'nosniff')
      .expect(200);
  });
  it('protects the canonical KYC review route', async () => {
    const path = '/api/v1/admin/kyc/64b000000000000000000002/review';
    const payload = { decision: 'verified', version: 1 };
    await request(app.getHttpServer()).post(path).send(payload).expect(401);
    await request(app.getHttpServer())
      .post(path)
      .set('Authorization', 'Bearer user')
      .send(payload)
      .expect(403);
    await request(app.getHttpServer())
      .post(path)
      .set('Authorization', 'Bearer admin')
      .send(payload)
      .expect(201);
    expect(usersService.reviewKycForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: '64b000000000000000000001',
        targetUserId: '64b000000000000000000002',
        decision: 'verified',
        expectedVersion: 1,
      }),
    );
  });
  it('rejects a KYC rejection without a reason', () =>
    request(app.getHttpServer())
      .post('/api/v1/admin/kyc/64b000000000000000000002/review')
      .set('Authorization', 'Bearer admin')
      .send({ decision: 'rejected', version: 1 })
      .expect(400));
});
