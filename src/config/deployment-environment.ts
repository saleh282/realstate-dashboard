/**
 * Deployment environment safety model (Phase 13).
 *
 * `NODE_ENV` only says how the process behaves; it cannot say WHICH deployment
 * a database belongs to. This module adds an explicit `DEPLOYMENT_ENV`, an
 * optional host/database allowlist, an in-database identity marker, and one
 * decision table (`assertActionAllowed`) that every seed, CLI and startup path
 * consults. Everything here is pure except `readEnvironmentMarker`, so the whole
 * matrix is unit-testable.
 */
import type { Db } from 'mongodb';

export const DEPLOYMENT_ENVS = ['local', 'development', 'staging', 'production'] as const;
export type DeploymentEnv = (typeof DEPLOYMENT_ENVS)[number];

/** Environments that must never run development conveniences or fake integrations. */
export const PROTECTED_ENVS: readonly DeploymentEnv[] = ['staging', 'production'];

export const ENVIRONMENT_MARKER_COLLECTION = '_environment';
export const ENVIRONMENT_MARKER_ID = 'deployment';

type Env = Record<string, unknown>;
const text = (env: Env, key: string) => String(env[key] ?? '').trim();

export class EnvironmentSafetyError extends Error {}

export type DeploymentEnvResolution = { env?: DeploymentEnv; errors: string[] };

/**
 * `DEPLOYMENT_ENV` is authoritative. When unset it is derived ONLY for
 * non-production `NODE_ENV` (test => local, development => development);
 * `NODE_ENV=production` must always say what it is. The two must agree:
 * a process with production guards (`NODE_ENV=production`) may be staging or
 * production, and a development process can never claim to be either.
 */
export function resolveDeploymentEnv(env: Env): DeploymentEnvResolution {
  const nodeEnv = text(env, 'NODE_ENV') || 'development';
  const declared = text(env, 'DEPLOYMENT_ENV').toLowerCase();
  if (!declared) {
    if (nodeEnv === 'production') return { errors: ['DEPLOYMENT_ENV is required in production: set it to staging or production'] };
    return { env: nodeEnv === 'test' ? 'local' : 'development', errors: [] };
  }
  if (!(DEPLOYMENT_ENVS as readonly string[]).includes(declared)) {
    return { errors: [`DEPLOYMENT_ENV must be one of ${DEPLOYMENT_ENVS.join(', ')}`] };
  }
  const value = declared as DeploymentEnv;
  if (nodeEnv === 'production' && !PROTECTED_ENVS.includes(value)) {
    return { errors: [`NODE_ENV=production cannot run as DEPLOYMENT_ENV=${value}`] };
  }
  if (nodeEnv !== 'production' && PROTECTED_ENVS.includes(value)) {
    return { errors: [`DEPLOYMENT_ENV=${value} requires NODE_ENV=production`] };
  }
  return { env: value, errors: [] };
}

/**
 * Fail-safe classification: a process is treated as protected (staging/production)
 * when NODE_ENV=production, when its environment cannot be resolved, or when it
 * declares a protected DEPLOYMENT_ENV.
 */
export function isProtectedProcess(env: Env): boolean {
  const resolved = resolveDeploymentEnv(env);
  return text(env, 'NODE_ENV') === 'production' || !resolved.env || PROTECTED_ENVS.includes(resolved.env);
}

/** Throwing variant for CLIs and startup. */
export function requireDeploymentEnv(env: Env): DeploymentEnv {
  const resolved = resolveDeploymentEnv(env);
  if (!resolved.env) throw new EnvironmentSafetyError(resolved.errors.join('; '));
  return resolved.env;
}

export type MongoTarget = { hosts: string[]; database: string };

export function parseMongoTarget(uri: string): MongoTarget {
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)\/?([^?]*)/i.exec(uri.trim());
  if (!match) throw new EnvironmentSafetyError('MONGO_URI is not a recognisable MongoDB connection string');
  return { hosts: match[1].split(',').map((host) => host.replace(/:\d+$/, '').toLowerCase()), database: decodeURIComponent(match[2] ?? '') };
}

const patternToRegExp = (pattern: string) =>
  new RegExp(`^${pattern.trim().toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

export function parseAllowlist(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

/** True when every host of the target, with its database, matches an allowlist entry (`host/database`, `*` wildcards). */
export function isTargetAllowed(target: MongoTarget, allowlist: string[]): boolean {
  if (!target.database) return false;
  const patterns = allowlist.map(patternToRegExp);
  return target.hosts.every((host) => patterns.some((pattern) => pattern.test(`${host}/${target.database.toLowerCase()}`)));
}

/**
 * Staging/production must state which databases they may touch; development
 * environments enforce the list only when one is configured.
 */
export function allowlistProblems(env: Env, deployment: DeploymentEnv): string[] {
  const allowlist = parseAllowlist(text(env, 'DB_ENV_ALLOWLIST'));
  const uri = text(env, 'MONGO_URI');
  if (PROTECTED_ENVS.includes(deployment) && !allowlist.length) return ['DB_ENV_ALLOWLIST is required in staging and production (comma-separated host/database patterns)'];
  if (!allowlist.length || !uri) return [];
  try {
    return isTargetAllowed(parseMongoTarget(uri), allowlist) ? [] : ['MONGO_URI does not match DB_ENV_ALLOWLIST'];
  } catch (error) {
    return [(error as Error).message];
  }
}

export type GuardedAction =
  | 'seed:dev-admin'
  | 'seed:super-admin'
  | 'seed:baseline'
  | 'migration:dry-run'
  | 'migration:apply'
  | 'integrity:read'
  | 'manifest:verify'
  | 'manifest:apply'
  | 'destructive:reset'
  | 'e2e:local'
  | 'fake-payments'
  | 'env:init';

type Rule = { allowed: readonly DeploymentEnv[]; confirm?: Partial<Record<DeploymentEnv, { variable: string; value?: string; hint: string }>> };

const ALL = DEPLOYMENT_ENVS;
const NON_PROTECTED: readonly DeploymentEnv[] = ['local', 'development'];

/** The single decision table: which action may run in which deployment, and which explicit confirmation it needs. */
export const ACTION_RULES: Record<GuardedAction, Rule> = {
  'seed:dev-admin': { allowed: NON_PROTECTED },
  'seed:super-admin': { allowed: ALL, confirm: { staging: { variable: 'SUPER_ADMIN_BOOTSTRAP_CONFIRM', value: 'CREATE_SUPER_ADMIN', hint: 'staging bootstrap' }, production: { variable: 'PRODUCTION_BOOTSTRAP_CONFIRM', value: 'CREATE_PRODUCTION_SUPER_ADMIN', hint: 'break-glass production bootstrap' } } },
  'seed:baseline': { allowed: ALL, confirm: { staging: { variable: 'BASELINE_SEED_CONFIRM', value: 'APPLY_BASELINE', hint: 'baseline seed' }, production: { variable: 'BASELINE_SEED_CONFIRM', value: 'APPLY_BASELINE', hint: 'baseline seed' } } },
  'migration:dry-run': { allowed: ALL },
  'migration:apply': { allowed: ALL, confirm: { staging: { variable: 'MIGRATION_BACKUP_CONFIRM', hint: 'a recorded pre-migration snapshot id' }, production: { variable: 'MIGRATION_BACKUP_CONFIRM', hint: 'a recorded pre-migration snapshot id' } } },
  'integrity:read': { allowed: ALL },
  'manifest:verify': { allowed: ALL },
  'manifest:apply': { allowed: ALL, confirm: { staging: { variable: 'MANIFEST_APPLY_CONFIRM', value: 'APPLY_MANIFEST', hint: 'manifest apply' }, production: { variable: 'MANIFEST_APPLY_CONFIRM', value: 'APPLY_MANIFEST', hint: 'manifest apply' } } },
  'destructive:reset': { allowed: ['local'], confirm: { local: { variable: 'DESTRUCTIVE_CONFIRM', value: 'RESET_DISPOSABLE_DATABASE', hint: 'destructive reset' } } },
  'e2e:local': { allowed: NON_PROTECTED },
  'fake-payments': { allowed: NON_PROTECTED },
  'env:init': { allowed: ALL },
};

/** Throws unless `action` may run in `deployment` with the given environment variables. */
export function assertActionAllowed(action: GuardedAction, deployment: DeploymentEnv, env: Env): void {
  const rule = ACTION_RULES[action];
  if (!rule.allowed.includes(deployment)) {
    throw new EnvironmentSafetyError(`Refused: "${action}" is not allowed in DEPLOYMENT_ENV=${deployment}`);
  }
  const confirm = rule.confirm?.[deployment];
  if (confirm) {
    const supplied = text(env, confirm.variable);
    if (!supplied || (confirm.value !== undefined && supplied !== confirm.value)) {
      throw new EnvironmentSafetyError(`Refused: "${action}" in DEPLOYMENT_ENV=${deployment} requires ${confirm.variable}${confirm.value ? `=${confirm.value}` : ''} (${confirm.hint})`);
    }
  }
}

export type EnvironmentMarker = { _id: string; env: DeploymentEnv; createdAt: Date; note?: string };

export async function readEnvironmentMarker(db: Db): Promise<EnvironmentMarker | null> {
  return (await db.collection<EnvironmentMarker>(ENVIRONMENT_MARKER_COLLECTION).findOne({ _id: ENVIRONMENT_MARKER_ID })) ?? null;
}

/** Marker rule: mandatory in staging/production, and whenever present it must equal the declared environment. */
export function markerProblems(marker: Pick<EnvironmentMarker, 'env'> | null, deployment: DeploymentEnv): string[] {
  if (!marker) return PROTECTED_ENVS.includes(deployment) ? [`the database has no environment marker; run env:init for DEPLOYMENT_ENV=${deployment} first`] : [];
  return marker.env === deployment ? [] : [`the database is marked "${marker.env}" but this process is DEPLOYMENT_ENV=${deployment}`];
}

/**
 * Full pre-flight for a CLI: resolve the environment, apply the allowlist, the
 * action table and (with a live database) the marker check.
 */
export async function guardAction(action: GuardedAction, env: Env, db?: Db): Promise<DeploymentEnv> {
  const deployment = requireDeploymentEnv(env);
  assertActionAllowed(action, deployment, env);
  const problems = allowlistProblems(env, deployment);
  if (problems.length) throw new EnvironmentSafetyError(`Refused: ${problems.join('; ')}`);
  if (db && action !== 'env:init') {
    const marker = markerProblems(await readEnvironmentMarker(db), deployment);
    if (marker.length) throw new EnvironmentSafetyError(`Refused: ${marker.join('; ')}`);
  }
  return deployment;
}

/** Startup validation, wired into `validateEnvironment`. */
export function deploymentEnvironmentErrors(env: Env): string[] {
  const resolved = resolveDeploymentEnv(env);
  if (!resolved.env) return resolved.errors;
  return allowlistProblems(env, resolved.env);
}
