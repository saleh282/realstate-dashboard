import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { KycController } from '../src/kyc/kyc.controller';
import { KycService } from '../src/kyc/kyc.service';

describe('legacy KYC review route removal', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [KycController],
      providers: [{ provide: KycService, useValue: {} }],
    })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => app.close());

  it.each([undefined, 'Bearer user', 'Bearer admin'])(
    'does not expose POST /kyc/review/:userId for %s',
    async (authorization) => {
      const call = request(app.getHttpServer())
        .post('/kyc/review/target-id')
        .send({ decision: 'verified', version: 0 });
      if (authorization) call.set('Authorization', authorization);
      await call.expect(404);
    },
  );
});
