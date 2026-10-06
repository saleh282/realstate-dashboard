'use strict';

const DEPLOYMENT_ENVS = ['local', 'development', 'staging', 'production'];
/** Environments that must never run development conveniences or fake integrations. */
const PROTECTED_ENVS = ['staging', 'production'];
const ENVIRONMENT_MARKER_COLLECTION = '_environment';
const ENVIRONMENT_MARKER_ID = 'deployment';
const text = (env, key) => String(env[key] ?? '').trim();
class EnvironmentSafetyError extends Error {}
/**
 * `DEPLOYMENT_ENV` is authoritative. When unset it is derived ONLY for
 * non-production `NODE_ENV` (test => local, development => development);
 * `NODE_ENV=production` must always say what it is. The two must agree:
 * a process with production guards (`NODE_ENV=production`) may be staging or
 * production, and a development process can never claim to be either.
 */
function resolveDeploymentEnv(env) {
  const nodeEnv = text(env, 'NODE_ENV') || 'development';
  const declared = text(env, 'DEPLOYMENT_ENV').toLowerCase();
  if (!declared) {
    if (nodeEnv === 'production')
      return {
        errors: ['DEPLOYMENT_ENV is required in production: set it to staging or production'],
      };
    return { env: nodeEnv === 'test' ? 'local' : 'development', errors: [] };
  }
  if (!DEPLOYMENT_ENVS.includes(declared)) {
    return { errors: [`DEPLOYMENT_ENV must be one of ${DEPLOYMENT_ENVS.join(', ')}`] };
  }
  const value = declared;
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
function isProtectedProcess(env) {
  const resolved = resolveDeploymentEnv(env);
  return (
    text(env, 'NODE_ENV') === 'production' || !resolved.env || PROTECTED_ENVS.includes(resolved.env)
  );
}
/** Throwing variant for CLIs and startup. */
function requireDeploymentEnv(env) {
  const resolved = resolveDeploymentEnv(env);
  if (!resolved.env) throw new EnvironmentSafetyError(resolved.errors.join('; '));
  return resolved.env;
}
function parseMongoTarget(uri) {
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)\/?([^?]*)/i.exec(uri.trim());
  if (!match)
    throw new EnvironmentSafetyError('MONGO_URI is not a recognisable MongoDB connection string');
  return {
    hosts: match[1].split(',').map((host) => host.replace(/:\d+$/, '').toLowerCase()),
    database: decodeURIComponent(match[2] ?? ''),
  };
}
const patternToRegExp = (pattern) =>
  new RegExp(
    `^${pattern
      .trim()
      .toLowerCase()
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')}$`,
  );
function parseAllowlist(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
/** True when every host of the target, with its database, matches an allowlist entry (`host/database`, `*` wildcards). */
function isTargetAllowed(target, allowlist) {
  if (!target.database) return false;
  const patterns = allowlist.map(patternToRegExp);
  return target.hosts.every((host) =>
    patterns.some((pattern) => pattern.test(`${host}/${target.database.toLowerCase()}`)),
  );
}
/**
 * Staging/production must state which databases they may touch; development
 * environments enforce the list only when one is configured.
 */
function allowlistProblems(env, deployment) {
  const allowlist = parseAllowlist(text(env, 'DB_ENV_ALLOWLIST'));
  const uri = text(env, 'MONGO_URI');
  if (PROTECTED_ENVS.includes(deployment) && !allowlist.length)
    return [
      'DB_ENV_ALLOWLIST is required in staging and production (comma-separated host/database patterns)',
    ];
  if (!allowlist.length || !uri) return [];
  try {
    return isTargetAllowed(parseMongoTarget(uri), allowlist)
      ? []
      : ['MONGO_URI does not match DB_ENV_ALLOWLIST'];
  } catch (error) {
    return [error.message];
  }
}
const ALL = DEPLOYMENT_ENVS;
const NON_PROTECTED = ['local', 'development'];
/** The single decision table: which action may run in which deployment, and which explicit confirmation it needs. */
const ACTION_RULES = {
  'migration:dry-run': { allowed: ALL },
  'migration:apply': {
    allowed: ALL,
    confirm: {
      staging: {
        variable: 'MIGRATION_BACKUP_CONFIRM',
        hint: 'a recorded pre-migration snapshot id',
      },
      production: {
        variable: 'MIGRATION_BACKUP_CONFIRM',
        hint: 'a recorded pre-migration snapshot id',
      },
    },
  },
  'integrity:read': { allowed: ALL },
  'manifest:verify': { allowed: ALL },
  'manifest:apply': {
    allowed: ALL,
    confirm: {
      staging: {
        variable: 'MANIFEST_APPLY_CONFIRM',
        value: 'APPLY_MANIFEST',
        hint: 'manifest apply',
      },
      production: {
        variable: 'MANIFEST_APPLY_CONFIRM',
        value: 'APPLY_MANIFEST',
        hint: 'manifest apply',
      },
    },
  },
  'destructive:reset': {
    allowed: ['local'],
    confirm: {
      local: {
        variable: 'DESTRUCTIVE_CONFIRM',
        value: 'RESET_DISPOSABLE_DATABASE',
        hint: 'destructive reset',
      },
    },
  },
  'e2e:local': { allowed: NON_PROTECTED },
  'env:init': { allowed: ALL },
};
/** Throws unless `action` may run in `deployment` with the given environment variables. */
function assertActionAllowed(action, deployment, env) {
  const rule = ACTION_RULES[action];
  if (!rule.allowed.includes(deployment)) {
    throw new EnvironmentSafetyError(
      `Refused: "${action}" is not allowed in DEPLOYMENT_ENV=${deployment}`,
    );
  }
  const confirm = rule.confirm?.[deployment];
  if (confirm) {
    const supplied = text(env, confirm.variable);
    if (!supplied || (confirm.value !== undefined && supplied !== confirm.value)) {
      throw new EnvironmentSafetyError(
        `Refused: "${action}" in DEPLOYMENT_ENV=${deployment} requires ${confirm.variable}${confirm.value ? `=${confirm.value}` : ''} (${confirm.hint})`,
      );
    }
  }
}
async function readEnvironmentMarker(db) {
  return (
    (await db.collection(ENVIRONMENT_MARKER_COLLECTION).findOne({ _id: ENVIRONMENT_MARKER_ID })) ??
    null
  );
}
/** Marker rule: mandatory in staging/production, and whenever present it must equal the declared environment. */
function markerProblems(marker, deployment) {
  if (!marker)
    return PROTECTED_ENVS.includes(deployment)
      ? [
          `the database has no environment marker; run env:init for DEPLOYMENT_ENV=${deployment} first`,
        ]
      : [];
  return marker.env === deployment
    ? []
    : [`the database is marked "${marker.env}" but this process is DEPLOYMENT_ENV=${deployment}`];
}
/**
 * Full pre-flight for a CLI: resolve the environment, apply the allowlist, the
 * action table and (with a live database) the marker check.
 */
async function guardAction(action, env, db) {
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
function deploymentEnvironmentErrors(env) {
  const resolved = resolveDeploymentEnv(env);
  if (!resolved.env) return resolved.errors;
  return allowlistProblems(env, resolved.env);
}

Object.assign(exports, {
  DEPLOYMENT_ENVS,
  PROTECTED_ENVS,
  ENVIRONMENT_MARKER_COLLECTION,
  ENVIRONMENT_MARKER_ID,
  EnvironmentSafetyError,
  resolveDeploymentEnv,
  isProtectedProcess,
  requireDeploymentEnv,
  parseMongoTarget,
  parseAllowlist,
  isTargetAllowed,
  allowlistProblems,
  ACTION_RULES,
  assertActionAllowed,
  readEnvironmentMarker,
  markerProblems,
  guardAction,
  deploymentEnvironmentErrors,
});
