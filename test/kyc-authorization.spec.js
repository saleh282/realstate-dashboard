'use strict';
const { httpApp } = require('./support/http-app');
const request = require('supertest');

const { KycController } = require('../src/controllers/kyc.controller');
const { KycService } = require('../src/services/kyc.service');
describe('legacy KYC review route removal', () => {
  let app;
  beforeAll(async () => {
    const moduleRef = await (() => {
      const services = {};
      services.KycService = {};
      return {
        services,
        app: httpApp(
          services,
          (app, services) => {
            app.use('/api/v1/kyc', require('../src/routes/kyc.routes').createRouter(services));
          },
          undefined,
        ),
      };
    })();
    app = moduleRef.app;
    await app.init();
  });
  afterAll(async () => app.close());
  it.each([undefined, 'Bearer user', 'Bearer admin'])(
    'does not expose POST /kyc/review/:userId for %s',
    async (authorization) => {
      const call = request(app.getHttpServer())
        .post('/api/v1/kyc/review/target-id')
        .send({ decision: 'verified', version: 0 });
      if (authorization) call.set('Authorization', authorization);
      await call.expect(404);
    },
  );
});
