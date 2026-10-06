'use strict';

function registerRoutes(app, services) {
  app.use('/api/v1/auth', require('./auth.routes').createRouter(services));
  app.use('/api/v1/broker', require('./broker-applications.routes').createRouter(services));
  app.use('/api/v1/geocoding', require('./geocoding.routes').createRouter(services));
  app.use('/health', require('./health.routes').createRouter(services));
  app.use('/api/v1/kyc', require('./kyc.routes').createRouter(services));
  app.use('/api/v1/legal-documents', require('./legal-documents.routes').createRouter(services));
  app.use('/api/v1/admin/listings', require('./admin-listings.routes').createRouter(services));
  app.use('/api/v1/admin/reports', require('./listing-reports.routes').createAdminRouter(services));
  app.use('/api/v1/listings', require('./listing-reports.routes').createRouter(services));
  app.use('/api/v1/listings', require('./listings.routes').createRouter(services));
  app.use('/api/v1/notifications', require('./notifications.routes').createRouter(services));
  app.use('/api/v1/users', require('./users.routes').createRouter(services));
}
module.exports = { registerRoutes };
