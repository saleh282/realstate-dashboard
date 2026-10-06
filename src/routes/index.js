'use strict';

function registerRoutes(app, services) {
  app.use('/api/v1/admin/audit-logs', require('./admin-audit.routes').createRouter(services));
  app.use('/api/v1/admin/dashboard', require('./admin-dashboard.routes').createRouter(services));
  app.use('/api/v1/admin/kyc', require('./admin-kyc.routes').createRouter(services));
  app.use('/api/v1/admin/operations', require('./admin-operations.routes').createRouter(services));
  app.use('/api/v1/admin/users', require('./admin-users.routes').createRouter(services));
  app.use('/api/v1/auth', require('./auth.routes').createRouter(services));
  app.use('/api/v1/admin', require('./admin-broker-applications.routes').createRouter(services));
  app.use('/api/v1/broker', require('./broker-applications.routes').createRouter(services));
  app.use('/api/v1/geocoding', require('./geocoding.routes').createRouter(services));
  app.use('/api/v1/admin/cities', require('./admin-cities.routes').createRouter(services));
  app.use(
    '/api/v1/admin/governorates',
    require('./admin-governorates.routes').createRouter(services),
  );
  app.use('/api/v1/governorates', require('./governorates.routes').createRouter(services));
  app.use('/health', require('./health.routes').createRouter(services));
  app.use('/api/v1/kyc', require('./kyc.routes').createRouter(services));
  app.use(
    '/api/v1/admin/legal-documents',
    require('./admin-legal-documents.routes').createRouter(services),
  );
  app.use('/api/v1/legal-documents', require('./legal-documents.routes').createRouter(services));
  app.use('/api/v1/notifications', require('./notifications.routes').createRouter(services));
  app.use('/api/v1/users', require('./users.routes').createRouter(services));
}
module.exports = { registerRoutes };
