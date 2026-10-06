const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
('use strict');
require('dotenv/config');
const { createApp, configureHttpServer } = require('./app');
const { createContext } = require('./config/database');
const { installProcessHandlers } = require('./common/process-handlers');
const { Logger } = require('./common/logging/logger');
const { redactSensitive } = require('./common/logging/redact');

async function startServer() {
  installProcessHandlers();
  const context = await createContext({ workers: true });
  let server;
  try {
    const app = createApp({ services: context.services });
    server = await new Promise((resolve, reject) => {
      const listening = app.listen(process.env.PORT || 3000, () => resolve(listening));
      listening.once('error', reject);
    });
    configureHttpServer(server);
    Logger.log(`Backend listening on port ${server.address().port}`, 'Bootstrap');
  } catch (error) {
    await context.close();
    throw error;
  }
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    try {
      await context.services.HealthService.beforeApplicationShutdown(signal);
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await context.close();
      process.exit(0);
    } catch (error) {
      Logger.error(redactSensitive(error.message), undefined, 'Shutdown');
      process.exit(1);
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return { server, context };
}
if (require.main === module)
  startServer().catch((error) => {
    Logger.error(redactSensitive(error.message), undefined, 'Bootstrap');
    process.exitCode = 1;
  });
module.exports = { startServer };
