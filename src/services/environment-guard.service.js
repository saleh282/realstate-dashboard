'use strict';

const { Logger } = require('../common/logging/logger');
const {
  EnvironmentSafetyError,
  isProtectedProcess,
  markerProblems,
  readEnvironmentMarker,
  requireDeploymentEnv,
} = require('../config/deployment-environment');
/**
 * Startup assertion: a staging/production process refuses to serve unless its
 * database carries the matching environment marker (written once by
 * `npm run env:init`). Development environments skip the database read so the
 * local workflow and unit-level module graphs are unaffected.
 */
class EnvironmentGuardService {
  constructor(config, connection) {
    this.config = config;
    this.connection = connection;
    this.logger = new Logger(EnvironmentGuardService.name);
  }
  async onApplicationBootstrap() {
    const env = {
      NODE_ENV: this.config.get('NODE_ENV'),
      DEPLOYMENT_ENV: this.config.get('DEPLOYMENT_ENV'),
    };
    if (!isProtectedProcess(env)) return;
    const deployment = requireDeploymentEnv(env);
    const db = this.connection.db;
    if (!db)
      throw new EnvironmentSafetyError(
        'Refused to start: no database connection to verify the environment marker',
      );
    const problems = markerProblems(await readEnvironmentMarker(db), deployment);
    if (problems.length)
      throw new EnvironmentSafetyError(`Refused to start: ${problems.join('; ')}`);
    this.logger.log(JSON.stringify({ event: 'environment_verified', deploymentEnv: deployment }));
  }
}

Object.assign(exports, { EnvironmentGuardService });
