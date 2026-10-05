'use strict';
const express = require('express');
const jwt = require('jsonwebtoken');
const { configureApp } = require('../../src/app');
const { errorHandler } = require('../../src/middleware/error-handler');
const { NotFoundException } = require('../../src/common/http/errors');

// Mount the production Express routers with explicitly supplied test services.
function httpApp(services, mounts, testAuthentication, env = { NODE_ENV: 'test' }) {
  const app = express();
  let server;
  if (testAuthentication) {
    services.JwtStrategy = {
      config: { get: () => 'http-test-secret' },
      validate: async (payload) => payload,
    };
    app.use(async (req, res, next) => {
      if (!req.headers.authorization) return next();
      try {
        await testAuthentication(req);
        req.headers.authorization = 'Bearer ' + jwt.sign(req.user, 'http-test-secret');
        next();
      } catch (error) {
        next(error);
      }
    });
  }
  app.init = async () => {
    configureApp(app, env);
    mounts(app, services);
    app.use((req, res, next) => next(new NotFoundException()));
    app.use(errorHandler);
    return app;
  };
  app.getHttpServer = () => server || app;
  const listen = app.listen.bind(app);
  app.listen = async (...args) => {
    await app.init();
    await new Promise((resolve) => {
      server = listen(...args, resolve);
    });
    return server;
  };
  app.close = async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  };
  return app;
}
module.exports = { httpApp };
