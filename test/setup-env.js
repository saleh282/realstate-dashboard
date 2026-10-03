// AppModule validates configuration when imported, even in skipped integration
// suites. Keep plain `npm test` independent of a developer's API credentials.
// Opt-in database suites must still supply their own disposable database URI.
if (process.env.PHASE12_LOCAL_E2E !== '1' && process.env.PHASE13_LOCAL_E2E !== '1') {
  process.env.MONGO_URI ??= 'mongodb://127.0.0.1:27017/test_unused';
}
process.env.JWT_ACCESS_SECRET ??= 'test-only-access-secret';
process.env.JWT_REFRESH_SECRET ??= 'test-only-refresh-secret';
process.env.JWT_ACCESS_EXPIRES_IN ??= '15m';
process.env.JWT_REFRESH_EXPIRES_IN ??= '7d';
