import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { EnvironmentSafetyError, isProtectedProcess, markerProblems, readEnvironmentMarker, requireDeploymentEnv } from './deployment-environment';

/**
 * Startup assertion: a staging/production process refuses to serve unless its
 * database carries the matching environment marker (written once by
 * `npm run env:init`). Development environments skip the database read so the
 * local workflow and unit-level module graphs are unaffected.
 */
@Injectable()
export class EnvironmentGuardService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EnvironmentGuardService.name);

  constructor(private readonly config: ConfigService, @InjectConnection() private readonly connection: Connection) {}

  async onApplicationBootstrap(): Promise<void> {
    const env = { NODE_ENV: this.config.get('NODE_ENV'), DEPLOYMENT_ENV: this.config.get('DEPLOYMENT_ENV') };
    if (!isProtectedProcess(env)) return;
    const deployment = requireDeploymentEnv(env);
    const db = this.connection.db;
    if (!db) throw new EnvironmentSafetyError('Refused to start: no database connection to verify the environment marker');
    const problems = markerProblems(await readEnvironmentMarker(db as never), deployment);
    if (problems.length) throw new EnvironmentSafetyError(`Refused to start: ${problems.join('; ')}`);
    this.logger.log(JSON.stringify({ event: 'environment_verified', deploymentEnv: deployment }));
  }
}
