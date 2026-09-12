import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';
import { UserRole } from '../src/auth/roles.enum';
import { KycController } from '../src/kyc/kyc.controller';
import { KycService } from '../src/kyc/kyc.service';

class TestJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const authorization = request.headers.authorization;
    if (!authorization) throw new UnauthorizedException();
    request.user = {
      userId: 'actor-id',
      role: authorization === 'Bearer admin' ? UserRole.ADMIN : UserRole.USER,
    };
    return true;
  }
}

describe('KYC review authorization', () => {
  let app: INestApplication;
  const review = jest.fn().mockResolvedValue({ kycStatus: 'verified' });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [KycController],
      providers: [RolesGuard, { provide: KycService, useValue: { review } }],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestJwtAuthGuard)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => app.close());

  beforeEach(() => review.mockClear());

  it('rejects an unauthenticated request with 401', async () => {
    await request(app.getHttpServer())
      .post('/kyc/review/target-id')
      .send({ decision: 'verified' })
      .expect(401);
    expect(review).not.toHaveBeenCalled();
  });

  it('rejects an authenticated normal user with 403', async () => {
    await request(app.getHttpServer())
      .post('/kyc/review/target-id')
      .set('Authorization', 'Bearer user')
      .send({ decision: 'verified' })
      .expect(403);
    expect(review).not.toHaveBeenCalled();
  });

  it('allows an authenticated admin', async () => {
    await request(app.getHttpServer())
      .post('/kyc/review/target-id')
      .set('Authorization', 'Bearer admin')
      .send({ decision: 'verified' })
      .expect(201);
    expect(review).toHaveBeenCalledWith('target-id', { decision: 'verified' });
  });
});
