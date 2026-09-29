import {
  ACTION_RULES, DEPLOYMENT_ENVS, EnvironmentSafetyError, GuardedAction, assertActionAllowed, guardAction, isProtectedProcess,
  isTargetAllowed, markerProblems, parseMongoTarget, resolveDeploymentEnv, requireDeploymentEnv,
} from '../src/config/deployment-environment';
import { EnvironmentGuardService } from '../src/config/environment-guard.service';
import { validateEnvironment } from '../src/config/environment.validation';

const base = { MONGO_URI: 'mongodb://localhost:27017/mazad_dev', JWT_ACCESS_SECRET: 'a', JWT_REFRESH_SECRET: 'b', JWT_ACCESS_EXPIRES_IN: '15m', JWT_REFRESH_EXPIRES_IN: '7d' };
const production = {
  ...base, NODE_ENV: 'production', DEPLOYMENT_ENV: 'production', DB_ENV_ALLOWLIST: 'db.prod.example/mazad',
  MONGO_URI: 'mongodb://user:pw@db.prod.example/mazad?retryWrites=true',
  JWT_ACCESS_SECRET: 'a'.repeat(40), JWT_REFRESH_SECRET: 'b'.repeat(40), TRUST_PROXY: 'false',
  MAIL_HOST: 'smtp.example.com', MAIL_PORT: '587', MAIL_SECURE: 'false', MAIL_USER: 'u', MAIL_PASS: 'p', MAIL_FROM: 'no-reply@example.com', MAIL_TLS_REJECT_UNAUTHORIZED: 'true',
  CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's', CORS_ORIGINS: 'https://admin.example.com',
  GEOCODING_USER_AGENT: 'Mazad/1.0', GEOCODING_PROVIDER_BASE_URL: 'https://geocoder.example.com',
};

describe('Phase 13 deployment environment resolution', () => {
  it.each([
    [{ NODE_ENV: 'test' }, 'local'],
    [{ NODE_ENV: 'development' }, 'development'],
    [{}, 'development'],
    [{ NODE_ENV: 'development', DEPLOYMENT_ENV: 'local' }, 'local'],
    [{ NODE_ENV: 'production', DEPLOYMENT_ENV: 'staging' }, 'staging'],
    [{ NODE_ENV: 'production', DEPLOYMENT_ENV: 'production' }, 'production'],
  ])('%j resolves to %s', (env, expected) => expect(resolveDeploymentEnv(env).env).toBe(expected));

  it.each([
    [{ NODE_ENV: 'production' }, 'DEPLOYMENT_ENV is required in production'],
    [{ NODE_ENV: 'production', DEPLOYMENT_ENV: 'development' }, 'cannot run as DEPLOYMENT_ENV=development'],
    [{ NODE_ENV: 'development', DEPLOYMENT_ENV: 'production' }, 'requires NODE_ENV=production'],
    [{ NODE_ENV: 'test', DEPLOYMENT_ENV: 'staging' }, 'requires NODE_ENV=production'],
    [{ DEPLOYMENT_ENV: 'prod' }, 'must be one of'],
  ])('%j is rejected', (env, message) => {
    expect(resolveDeploymentEnv(env).errors.join()).toContain(message);
    expect(() => requireDeploymentEnv(env)).toThrow(EnvironmentSafetyError);
  });

  it('treats an unresolvable or production process as protected (fail safe)', () => {
    expect(isProtectedProcess({ NODE_ENV: 'production' })).toBe(true);
    expect(isProtectedProcess({ NODE_ENV: 'development', DEPLOYMENT_ENV: 'nonsense' })).toBe(true);
    expect(isProtectedProcess({ NODE_ENV: 'development' })).toBe(false);
  });
});

describe('Phase 13 database allowlist', () => {
  it('parses hosts and database from the connection string without its credentials', () => {
    expect(parseMongoTarget('mongodb+srv://u:p@Cluster0.abc.mongodb.net/real-estate?appName=x')).toEqual({ hosts: ['cluster0.abc.mongodb.net'], database: 'real-estate' });
    expect(parseMongoTarget('mongodb://a:1,b:2/mazad?replicaSet=r')).toEqual({ hosts: ['a', 'b'], database: 'mazad' });
  });

  it('matches host/database patterns and never matches a missing database', () => {
    const target = parseMongoTarget('mongodb://db.prod.example/mazad');
    expect(isTargetAllowed(target, ['db.prod.example/mazad'])).toBe(true);
    expect(isTargetAllowed(target, ['*.prod.example/mazad'])).toBe(true);
    expect(isTargetAllowed(target, ['db.prod.example/other'])).toBe(false);
    expect(isTargetAllowed(target, ['db.staging.example/mazad'])).toBe(false);
    expect(isTargetAllowed(parseMongoTarget('mongodb://db.prod.example'), ['*/*'])).toBe(false);
  });

  it('is mandatory in staging/production and enforced in development only when configured', () => {
    expect(() => validateEnvironment({ ...production, DB_ENV_ALLOWLIST: '' })).toThrow('DB_ENV_ALLOWLIST is required');
    expect(() => validateEnvironment({ ...production, DB_ENV_ALLOWLIST: 'other.example/mazad' })).toThrow('does not match DB_ENV_ALLOWLIST');
    expect(() => validateEnvironment(production)).not.toThrow();
    expect(() => validateEnvironment({ ...base, NODE_ENV: 'development' })).not.toThrow();
    expect(() => validateEnvironment({ ...base, NODE_ENV: 'development', DB_ENV_ALLOWLIST: 'other/x' })).toThrow('does not match');
  });

  it('cannot start production without DEPLOYMENT_ENV', () => {
    const { DEPLOYMENT_ENV, ...withoutEnv } = production;
    expect(() => validateEnvironment(withoutEnv)).toThrow('DEPLOYMENT_ENV is required in production');
  });
});

describe('Phase 13 action decision table', () => {
  const confirmations = {
    SUPER_ADMIN_BOOTSTRAP_CONFIRM: 'CREATE_SUPER_ADMIN', PRODUCTION_BOOTSTRAP_CONFIRM: 'CREATE_PRODUCTION_SUPER_ADMIN',
    BASELINE_SEED_CONFIRM: 'APPLY_BASELINE', MIGRATION_BACKUP_CONFIRM: 'snap-2026-01-01', MANIFEST_APPLY_CONFIRM: 'APPLY_MANIFEST', DESTRUCTIVE_CONFIRM: 'RESET_DISPOSABLE_DATABASE',
  };
  const allowed: Record<GuardedAction, string[]> = {
    'seed:dev-admin': ['local', 'development'],
    'seed:super-admin': [...DEPLOYMENT_ENVS],
    'seed:baseline': [...DEPLOYMENT_ENVS],
    'migration:dry-run': [...DEPLOYMENT_ENVS],
    'migration:apply': [...DEPLOYMENT_ENVS],
    'integrity:read': [...DEPLOYMENT_ENVS],
    'manifest:verify': [...DEPLOYMENT_ENVS],
    'manifest:apply': [...DEPLOYMENT_ENVS],
    'destructive:reset': ['local'],
    'e2e:local': ['local', 'development'],
    'fake-payments': ['local', 'development'],
    'env:init': [...DEPLOYMENT_ENVS],
  };

  it('covers every declared action', () => expect(Object.keys(ACTION_RULES).sort()).toEqual(Object.keys(allowed).sort()));

  it.each(Object.keys(allowed) as GuardedAction[])('%s is allowed exactly where the table says (with every confirmation supplied)', (action) => {
    for (const env of DEPLOYMENT_ENVS) {
      const run = () => assertActionAllowed(action, env, confirmations);
      if (allowed[action].includes(env)) expect(run).not.toThrow();
      else expect(run).toThrow(/not allowed in DEPLOYMENT_ENV/);
    }
  });

  it('never lets production reset, seed the dev admin, run the local E2E or use fake payments', () => {
    for (const action of ['destructive:reset', 'seed:dev-admin', 'e2e:local', 'fake-payments'] as GuardedAction[]) {
      expect(() => assertActionAllowed(action, 'production', confirmations)).toThrow(EnvironmentSafetyError);
      expect(() => assertActionAllowed(action, 'staging', confirmations)).toThrow(EnvironmentSafetyError);
    }
  });

  it.each([
    ['seed:super-admin', 'production', 'PRODUCTION_BOOTSTRAP_CONFIRM'],
    ['seed:super-admin', 'staging', 'SUPER_ADMIN_BOOTSTRAP_CONFIRM'],
    ['migration:apply', 'production', 'MIGRATION_BACKUP_CONFIRM'],
    ['migration:apply', 'staging', 'MIGRATION_BACKUP_CONFIRM'],
    ['manifest:apply', 'production', 'MANIFEST_APPLY_CONFIRM'],
    ['seed:baseline', 'production', 'BASELINE_SEED_CONFIRM'],
    ['destructive:reset', 'local', 'DESTRUCTIVE_CONFIRM'],
  ] as const)('%s in %s needs an explicit %s', (action, env, variable) => {
    expect(() => assertActionAllowed(action, env, {})).toThrow(variable);
    // Token confirmations must match exactly; the backup confirmation only needs a recorded snapshot id.
    if (variable !== 'MIGRATION_BACKUP_CONFIRM') expect(() => assertActionAllowed(action, env, { [variable]: 'wrong' })).toThrow(variable);
    else expect(() => assertActionAllowed(action, env, { [variable]: 'snap-1' })).not.toThrow();
  });

  it('does not require confirmations for development migrations or a local admin seed', () => {
    expect(() => assertActionAllowed('migration:apply', 'development', {})).not.toThrow();
    expect(() => assertActionAllowed('seed:dev-admin', 'local', {})).not.toThrow();
  });
});

describe('Phase 13 environment marker', () => {
  it('is mandatory in protected environments and must match wherever it exists', () => {
    expect(markerProblems(null, 'production')[0]).toContain('no environment marker');
    expect(markerProblems(null, 'staging')[0]).toContain('no environment marker');
    expect(markerProblems(null, 'development')).toEqual([]);
    expect(markerProblems({ env: 'production' }, 'production')).toEqual([]);
    expect(markerProblems({ env: 'staging' }, 'production')[0]).toContain('marked "staging"');
    expect(markerProblems({ env: 'production' }, 'development')[0]).toContain('marked "production"');
  });

  const dbWith = (marker: unknown) => ({ collection: () => ({ findOne: async () => marker }) }) as any;

  it('guardAction refuses a database whose marker disagrees or is absent in production', async () => {
    const env = { ...production, MIGRATION_BACKUP_CONFIRM: 'snap-1' };
    await expect(guardAction('migration:apply', env, dbWith(null))).rejects.toThrow('no environment marker');
    await expect(guardAction('migration:apply', env, dbWith({ env: 'staging' }))).rejects.toThrow('marked "staging"');
    await expect(guardAction('migration:apply', env, dbWith({ env: 'production' }))).resolves.toBe('production');
    await expect(guardAction('migration:apply', { ...env, MIGRATION_BACKUP_CONFIRM: '' }, dbWith({ env: 'production' }))).rejects.toThrow('MIGRATION_BACKUP_CONFIRM');
  });

  it('refuses a development database that is marked production', async () => {
    await expect(guardAction('integrity:read', { NODE_ENV: 'development', MONGO_URI: base.MONGO_URI }, dbWith({ env: 'production' }))).rejects.toThrow('marked "production"');
  });

  it('startup refuses to serve when the production marker is missing or wrong, and skips the read in development', async () => {
    const service = (env: Record<string, string>, marker: unknown) => new EnvironmentGuardService(
      { get: (key: string) => env[key] } as any,
      { db: dbWith(marker) } as any,
    );
    await expect(service({ NODE_ENV: 'production', DEPLOYMENT_ENV: 'production' }, null).onApplicationBootstrap()).rejects.toThrow('Refused to start');
    await expect(service({ NODE_ENV: 'production', DEPLOYMENT_ENV: 'production' }, { env: 'staging' }).onApplicationBootstrap()).rejects.toThrow('marked "staging"');
    await expect(service({ NODE_ENV: 'production', DEPLOYMENT_ENV: 'production' }, { env: 'production' }).onApplicationBootstrap()).resolves.toBeUndefined();
    await expect(service({ NODE_ENV: 'development' }, null).onApplicationBootstrap()).resolves.toBeUndefined();
  });
});

describe('Phase 13 every seeding / destructive / migration tool calls its environment guard', () => {
  // The seeds and CLIs execute on import, so they are checked structurally: removing a guard fails this test.
  const { readFileSync } = jest.requireActual('node:fs') as typeof import('node:fs');
  const { join } = jest.requireActual('node:path') as typeof import('node:path');
  const source = (file: string) => readFileSync(join(__dirname, '..', file), 'utf8');
  it.each([
    ['src/seeds/admin.seed.ts', 'seed:dev-admin'],
    ['src/seeds/super-admin.seed.ts', 'seed:super-admin'],
    ['src/seeds/baseline-catalog.seed.ts', 'seed:baseline'],
    ['src/migrations/cli.ts', 'migration:apply'],
    ['src/migrations/cli.ts', 'migration:dry-run'],
    ['src/migrations/integrity-cli.ts', 'integrity:read'],
    ['src/scripts/release-manifest.ts', 'manifest:apply'],
    ['src/scripts/release-manifest.ts', 'manifest:verify'],
    ['src/scripts/env-init.ts', 'env:init'],
    ['src/scripts/phase12-rebuild-baseline.ts', 'manifest:apply'],
    ['src/scripts/phase13-scale-harness.ts', 'destructive:reset'],
    ['src/scripts/phase13-migration-rehearsal.ts', 'destructive:reset'],
    ['src/scripts/phase13-restore-drill.ts', 'destructive:reset'],
  ])('%s guards %s', (file, action) => {
    expect(source(file)).toMatch(new RegExp(`guardAction\\(\\s*[^)]*'${action}'`));
  });

  it('the write-capable engineering tools also restrict their target to disposable localhost databases', () => {
    for (const file of ['src/scripts/phase13-scale-harness.ts', 'src/scripts/phase13-migration-rehearsal.ts', 'src/scripts/phase13-restore-drill.ts']) {
      expect(source(file)).toContain('assertDisposableTarget(');
    }
  });

  it('the application module wires the startup marker guard', () => {
    expect(source('src/app.module.ts')).toContain('EnvironmentGuardService');
  });
});
