'use strict';
require('reflect-metadata');
const mongoose = require('mongoose');
const { validateEnvironment } = require('./environment.validation');
const { createModels } = require('../models');
const { createServices } = require('./services');

async function createContext({ env = process.env, initialize = true, workers = false } = {}) {
  const config = validateEnvironment({ ...env });
  const connection = await mongoose
    .createConnection(config.MONGO_URI, { serverSelectionTimeoutMS: 10000 })
    .asPromise();
  let services;
  try {
    const models = createModels(connection);
    services = createServices(connection, models, config);
    // Validate the database environment BEFORE initializers can write catalog data.
    await services.EnvironmentGuardService.onApplicationBootstrap();
    if (initialize) {
      await services.GovernoratesService.onModuleInit();
    }
    services.NotificationsOutboxConsumer.onModuleInit();
    if (workers) {
      services.EvidenceCleanupWorker.onApplicationBootstrap();
      services.OutboxDispatcherWorker.onApplicationBootstrap();
    }
    return {
      connection,
      models,
      services,
      async close() {
        await stopWorkers(services);
        await connection.close();
      },
    };
  } catch (error) {
    if (services) await stopWorkers(services);
    await connection.close();
    throw error;
  }
}
async function stopWorkers(services) {
  await Promise.all([
    services.EvidenceCleanupWorker.onModuleDestroy(),
    services.OutboxDispatcherWorker.onModuleDestroy(),
  ]);
}
module.exports = { createContext, stopWorkers };
