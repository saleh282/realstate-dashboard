'use strict';

function registerRoutes(app, services) {
  app.use('/api/v1/admin/audit-logs', require('./admin-audit.routes').createRouter(services));
  app.use('/api/v1/admin/companies', require('./admin-companies.routes').createRouter(services));
  app.use('/api/v1/admin/dashboard', require('./admin-dashboard.routes').createRouter(services));
  app.use('/api/v1/admin/kyc', require('./admin-kyc.routes').createRouter(services));
  app.use('/api/v1/admin/operations', require('./admin-operations.routes').createRouter(services));
  app.use('/api/v1/admin/users', require('./admin-users.routes').createRouter(services));
  app.use('/api/v1/admin/amenities', require('./admin-amenities.routes').createRouter(services));
  app.use('/api/v1/amenities', require('./amenities.routes').createRouter(services));
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
  app.use(
    '/api/v1/admin/managed-marketing',
    require('./admin-managed-marketing.routes').createRouter(services),
  );
  app.use(
    '/api/v1/managed-marketing',
    require('./managed-marketing.routes').createRouter(services),
  );
  app.use('/api/v1/notifications', require('./notifications.routes').createRouter(services));
  app.use('/api/v1/admin/properties', require('./admin-properties.routes').createRouter(services));
  app.use('/api/v1/properties', require('./properties.routes').createRouter(services));
  app.use(
    '/api/v1/admin/property-attributes',
    require('./admin-property-attributes.routes').createRouter(services),
  );
  app.use(
    '/api/v1/admin/property-form-definitions',
    require('./admin-property-form-definitions.routes').createRouter(services),
  );
  app.use(
    '/api/v1/property-form-definitions',
    require('./property-form-definitions.routes').createRouter(services),
  );
  app.use(
    '/api/v1/property-form-options',
    require('./property-form-options.routes').createRouter(services),
  );
  app.use(
    '/api/v1/admin/property-options',
    require('./admin-property-options.routes').createRouter(services),
  );
  app.use('/api/v1/property-options', require('./property-options.routes').createRouter(services));
  app.use(
    '/api/v1/admin/property-purpose-categories',
    require('./admin-property-purpose-categories.routes').createRouter(services),
  );
  app.use(
    '/api/v1/property-purpose-categories',
    require('./property-purpose-categories.routes').createRouter(services),
  );
  app.use(
    '/api/v1/admin/property-types',
    require('./admin-property-types.routes').createRouter(services),
  );
  app.use('/api/v1/property-types', require('./property-types.routes').createRouter(services));
  app.use('/api/v1/users', require('./users.routes').createRouter(services));
  app.use(
    '/api/v1/dev/fake-payments',
    require('./fake-payments-dev.routes').createRouter(services),
  );
}
module.exports = { registerRoutes };
