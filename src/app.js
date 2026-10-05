'use strict';
require('reflect-metadata');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { registerRoutes } = require('./routes');
const { requestIdMiddleware } = require('./common/request-context/request-context');
const { buildCorsOptions } = require('./config/cors.config');
const { parseTrustProxy } = require('./config/trust-proxy.config');
const { errorHandler } = require('./middleware/error-handler');
const { NotFoundException } = require('./common/http/errors');
const { Logger } = require('./common/logging/logger');

function configureApp(app, env = process.env) {
  app.disable('x-powered-by');
  const trustProxy = parseTrustProxy(env.TRUST_PROXY).setting;
  app.set('trust proxy', trustProxy);
  if (env.NODE_ENV === 'production') {
    if (trustProxy === false)
      new Logger('Bootstrap').warn(
        'TRUST_PROXY=false: forwarded client addresses are ignored. Use this only when clients connect directly.',
      );
    else if (typeof trustProxy === 'number')
      new Logger('Bootstrap').warn(
        `TRUST_PROXY=${trustProxy} (hop count): safe only when every request crosses exactly that many proxies.`,
      );
  }
  app.use(requestIdMiddleware);
  app.use(helmet());
  app.use(cors(buildCorsOptions(env)));
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  return app;
}
function createApp({ services, env = process.env } = {}) {
  if (!services) throw new Error('createApp requires services');
  const app = configureApp(express(), env);
  app.locals.services = services;
  registerRoutes(app, services);
  app.use((req, res, next) => next(new NotFoundException(`Cannot ${req.method} ${req.path}`)));
  app.use(errorHandler);
  return app;
}
function configureHttpServer(server) {
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
}
module.exports = { createApp, configureApp, configureHttpServer };
