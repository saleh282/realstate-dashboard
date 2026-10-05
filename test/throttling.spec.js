'use strict';
const express = require('express');
const request = require('supertest');
const { rateLimit } = require('../src/middleware/rate-limit');
const { errorHandler } = require('../src/middleware/error-handler');
const { createRouter } = require('../src/routes/auth.routes');
it('returns 429 and Retry-After after the per-client limit', async () => {
  const app = express();
  app.get('/limited', rateLimit({ default: { limit: 2, ttl: 60000 } }), (req, res) =>
    res.json({ ok: true }),
  );
  app.use(errorHandler);
  await request(app).get('/limited').expect(200);
  await request(app).get('/limited').expect(200);
  const res = await request(app).get('/limited').expect(429);
  expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
});
it.each([
  ['register', 3],
  ['login', 5],
  ['forgot-password', 3],
  ['resend-otp', 3],
  ['verify-otp', 5],
  ['reset-password', 5],
  ['refresh', 10],
])('retains the limit on auth/%s', async (path, limit) => {
  const app = express();
  app.use(express.json());
  app.use('/auth', createRouter({ AuthService: {} }));
  app.use(errorHandler);
  for (let i = 0; i < limit; i++)
    expect(
      (
        await request(app)
          .post('/auth/' + path)
          .send({})
      ).status,
    ).toBe(400);
  await request(app)
    .post('/auth/' + path)
    .send({})
    .expect(429);
});
