import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { THROTTLER_LIMIT } from '@nestjs/throttler/dist/throttler.constants';
import request from 'supertest';
import { AuthController } from '../src/auth/auth.controller';

@Controller('limited')
class LimitedController {
  @Get()
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  get() {
    return { ok: true };
  }
}

describe('ThrottlerGuard integration', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: 60000, limit: 20 }] })],
      controllers: [LimitedController],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => app.close());

  it('returns 429 after the configured request limit', async () => {
    await request(app.getHttpServer()).get('/limited').expect(200);
    await request(app.getHttpServer()).get('/limited').expect(200);
    await request(app.getHttpServer()).get('/limited').expect(429);
  });

  it('declares tighter limits on every sensitive authentication endpoint', () => {
    const expectedLimits: Array<[keyof AuthController, number]> = [
      ['register', 3],
      ['login', 5],
      ['forgotPassword', 3],
      ['resendOtp', 3],
      ['verifyOtp', 5],
      ['resetPassword', 5],
    ];

    for (const [method, limit] of expectedLimits) {
      expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, AuthController.prototype[method])).toBe(
        limit,
      );
    }
  });
});
