import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminKycController } from '../src/admin/admin-kyc.controller';
import { AdminUsersController } from '../src/admin/admin-users.controller';
import { AdminDashboardController } from '../src/admin/admin-dashboard.controller';
import { AdminAuditController } from '../src/admin/admin-audit.controller';
import { AuditLogService } from '../src/audit/audit-log.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';
import { UserRole } from '../src/auth/roles.enum';
import { CloudinaryAssetService } from '../src/config/cloudinary-asset.service';
import { UsersService } from '../src/users/users.service';

class TestJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const httpRequest = context.switchToHttp().getRequest();
    const authorization = httpRequest.headers.authorization;
    if (!authorization) throw new UnauthorizedException();
    httpRequest.user = {
      userId: '64b000000000000000000001',
      role:
        authorization === 'Bearer admin' ? UserRole.ADMIN : UserRole.USER,
    };
    return true;
  }
}

describe('admin controller authorization', () => {
  let app: INestApplication;
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

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        AdminUsersController,
        AdminKycController,
        AdminDashboardController,
        AdminAuditController,
      ],
      providers: [
        RolesGuard,
        { provide: UsersService, useValue: usersService },
        { provide: AuditLogService, useValue: auditLogService },
        {
          provide: CloudinaryAssetService,
          useValue: cloudinaryAssetService,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestJwtAuthGuard)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterAll(async () => app.close());

  it('returns 401 for an unauthenticated admin route request', () =>
    request(app.getHttpServer()).get('/admin/users').expect(401));

  it('returns 403 for a normal user', () =>
    request(app.getHttpServer())
      .get('/admin/users')
      .set('Authorization', 'Bearer user')
      .expect(403));

  it('allows an administrator', () =>
    request(app.getHttpServer())
      .get('/admin/users')
      .set('Authorization', 'Bearer admin')
      .expect(200));

  it.each([
    '/admin/kyc',
    '/admin/dashboard/metrics',
    '/admin/audit-logs',
  ])('enforces admin role on %s', async (path) => {
    await request(app.getHttpServer())
      .get(path)
      .set('Authorization', 'Bearer user')
      .expect(403);
    await request(app.getHttpServer())
      .get(path)
      .set('Authorization', 'Bearer admin')
      .expect(200);
  });

  it('protects and streams KYC documents only to an administrator', async () => {
    await request(app.getHttpServer())
      .get('/admin/kyc/64b000000000000000000002/documents/id-front')
      .set('Authorization', 'Bearer user')
      .expect(403);

    await request(app.getHttpServer())
      .get('/admin/kyc/64b000000000000000000002/documents/id-front')
      .set('Authorization', 'Bearer admin')
      .expect('Content-Type', 'image/jpeg')
      .expect('Cache-Control', 'private, no-store, max-age=0')
      .expect(200);
  });

  it('protects the canonical KYC review route', async () => {
    const path = '/admin/kyc/64b000000000000000000002/review';
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
      .post('/admin/kyc/64b000000000000000000002/review')
      .set('Authorization', 'Bearer admin')
      .send({ decision: 'rejected', version: 1 })
      .expect(400));
});
