'use strict';
const mongoose = require('mongoose');
const { createModels } = require('../src/models');
const { createServices } = require('../src/config/services');
it('shares the same outbox instance between every producer and registers the notifications consumer', async () => {
  const connection = mongoose.createConnection();
  const services = createServices(connection, createModels(connection), {
    NODE_ENV: 'test',
    GEOCODING_PROVIDER: 'disabled',
  });
  expect(services.UsersService.outbox).toBe(services.OutboxService);
  expect(services.PropertiesService.outbox).toBe(services.OutboxService);
  expect(services.ManagedMarketingPaymentConfirmationService.outbox).toBe(services.OutboxService);
  expect(services.OutboxDispatcherWorker.registry).toBe(services.OutboxConsumerRegistry);
  expect(services.OutboxDispatcherWorker.wakeup).toBe(services.OutboxWakeup);
  services.NotificationsOutboxConsumer.onModuleInit();
  expect(services.OutboxConsumerRegistry.list()).toContain(services.NotificationsOutboxConsumer);
  await connection.destroy();
});
