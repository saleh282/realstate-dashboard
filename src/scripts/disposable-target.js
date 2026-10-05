'use strict';

const { EnvironmentSafetyError, parseMongoTarget } = require('../config/deployment-environment');
/**
 * Shared target guard for the Phase 13 write-capable engineering tools (scale
 * harness, migration rehearsal, restore drill): localhost only, and a database
 * whose name carries the `mazad_phase13_` prefix. Anything else is refused
 * before a connection is opened.
 */
const DISPOSABLE_DB_PREFIX = 'mazad_phase13_';
function assertDisposableTarget(uri) {
  if (!uri) throw new EnvironmentSafetyError('MONGO_URI is required');
  const target = parseMongoTarget(uri);
  const local =
    target.hosts.length > 0 &&
    target.hosts.every((host) => host === '127.0.0.1' || host === 'localhost');
  if (!local || !target.database.startsWith(DISPOSABLE_DB_PREFIX)) {
    throw new EnvironmentSafetyError(
      `Refused: this tool only runs against localhost databases named ${DISPOSABLE_DB_PREFIX}*`,
    );
  }
  return { uri, database: target.database };
}

Object.assign(exports, { DISPOSABLE_DB_PREFIX, assertDisposableTarget });
