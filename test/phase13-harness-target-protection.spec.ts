import { assertActionAllowed, requireDeploymentEnv } from '../src/config/deployment-environment';
import { assertDisposableTarget } from '../src/scripts/disposable-target';

/**
 * The write-capable Phase 13 harnesses (scale, rehearsal, restore drill) run exactly this chain:
 *   1. assertDisposableTarget(MONGO_URI)                  -- loopback host + mazad_phase13_* database
 *   2. guardAction('destructive:reset', process.env)     -- DEPLOYMENT_ENV=local + DESTRUCTIVE_CONFIRM
 * No environment variable can satisfy (1); (2) refuses development, staging and production.
 */
const ATLAS_SRV = 'mongodb+srv://user:pw@cluster0.jepfa3a.mongodb.net/mazad_phase13_scale';
const ATLAS_STANDARD = 'mongodb://user:pw@cluster0-shard-00-00.jepfa3a.mongodb.net:27017,cluster0-shard-00-01.jepfa3a.mongodb.net:27017/mazad_phase13_scale?replicaSet=x';
const REMOTE = 'mongodb://db.example.invalid:27017/mazad_phase13_scale';
const LOCAL_NORMAL = 'mongodb://127.0.0.1:27017/real-estate-auction';
const LOCAL_PHASE12 = 'mongodb://127.0.0.1:57077/mazad_phase12_disposable?replicaSet=testset';
const LOCAL_DISPOSABLE = 'mongodb://127.0.0.1:57077/mazad_phase13_scale?replicaSet=testset';

const ALL_SWITCHES = { PHASE12_DISPOSABLE_DB: '1', DESTRUCTIVE_CONFIRM: 'RESET_DISPOSABLE_DATABASE', MIGRATION_BACKUP_CONFIRM: 'snap', MANIFEST_APPLY_CONFIRM: 'APPLY_MANIFEST', BASELINE_SEED_CONFIRM: 'APPLY_BASELINE' };
const nodeEnvFor = (deployment: string) => (deployment === 'staging' || deployment === 'production' ? 'production' : 'development');

/** The harness chain, with every opt-in switch set: only the target and the deployment can decide. */
function harnessChain(deployment: string, uri: string) {
  const env = { ...ALL_SWITCHES, NODE_ENV: nodeEnvFor(deployment), DEPLOYMENT_ENV: deployment, MONGO_URI: uri };
  assertDisposableTarget(env.MONGO_URI);
  assertActionAllowed('destructive:reset', requireDeploymentEnv(env), env);
}

describe('Phase 13 harness target protection (environment x target)', () => {
  it.each([
    ['development + Atlas (srv)', 'development', ATLAS_SRV],
    ['development + Atlas (standard, multi-host)', 'development', ATLAS_STANDARD],
    ['local + Atlas (srv)', 'local', ATLAS_SRV],
    ['development + arbitrary remote MongoDB', 'development', REMOTE],
    ['local + arbitrary remote MongoDB', 'local', REMOTE],
    ['development + localhost, normal database name', 'development', LOCAL_NORMAL],
    ['local + localhost, normal database name', 'local', LOCAL_NORMAL],
    ['local + localhost, the Phase 12 database (Phase 13 tools never touch it)', 'local', LOCAL_PHASE12],
  ])('refuses %s even with every opt-in switch set', (_name, deployment, uri) => {
    expect(() => harnessChain(deployment, uri)).toThrow(/Refused/);
  });

  it.each(['staging', 'production'])('refuses %s even against a disposable-looking localhost target', (deployment) => {
    expect(() => harnessChain(deployment, LOCAL_DISPOSABLE)).toThrow(/not allowed in DEPLOYMENT_ENV/);
  });

  it('a development deployment is refused even for the disposable localhost target (harnesses are local-only)', () => {
    expect(() => harnessChain('development', LOCAL_DISPOSABLE)).toThrow(/not allowed in DEPLOYMENT_ENV=development/);
  });

  it('allows exactly one combination: DEPLOYMENT_ENV=local + loopback + mazad_phase13_* + the explicit confirmation', () => {
    expect(() => harnessChain('local', LOCAL_DISPOSABLE)).not.toThrow();
    expect(() => harnessChain('local', 'mongodb://localhost/mazad_phase13_drill')).not.toThrow();
    const env = { NODE_ENV: 'development', DEPLOYMENT_ENV: 'local', MONGO_URI: LOCAL_DISPOSABLE };
    expect(() => assertActionAllowed('destructive:reset', 'local', env)).toThrow('DESTRUCTIVE_CONFIRM');
  });

  it.each([
    'mongodb://127.0.0.1@evil.example/mazad_phase13_scale',
    'mongodb://localhost.evil.example/mazad_phase13_scale',
    'mongodb://127.0.0.1,evil.example/mazad_phase13_scale',
    'mongodb://user:pw@127.0.0.1.evil.example:27017/mazad_phase13_scale',
    'mongodb://[::1]:27017/mazad_phase13_scale',
  ])('the host check cannot be fooled by a look-alike URI (%s)', (uri) => {
    expect(() => assertDisposableTarget(uri)).toThrow(/Refused/);
  });

  it('the target guard reads only the connection string: no environment variable is an input to it', () => {
    expect(assertDisposableTarget.length).toBe(1);
  });
});

describe('Phase 13 harness entry points run their guards before opening any connection', () => {
  const { readFileSync } = jest.requireActual('node:fs') as typeof import('node:fs');
  const { join } = jest.requireActual('node:path') as typeof import('node:path');
  const source = (file: string) => readFileSync(join(__dirname, '..', file), 'utf8');
  const mainOf = (file: string) => { const text = source(file); return text.slice(text.indexOf('async function main()')); };

  it.each([
    'src/scripts/phase13-scale-harness.ts',
    'src/scripts/phase13-migration-rehearsal.ts',
    'src/scripts/phase13-restore-drill.ts',
  ])('%s: target guard, then destructive guard, then connect', (file) => {
    const main = mainOf(file);
    const target = main.search(/assertDisposableTarget\(|guardTarget\(\)/);
    const destructive = main.indexOf("guardAction('destructive:reset'");
    const connect = main.indexOf('.connect()');
    expect(target).toBeGreaterThanOrEqual(0);
    expect(destructive).toBeGreaterThan(target);
    expect(connect).toBeGreaterThan(destructive);
  });

  it('the scale harness has no mode that skips the destructive guard (measure-only rebuilds indexes)', () => {
    expect(source('src/scripts/phase13-scale-harness.ts')).not.toMatch(/measureOnly\s*\?\s*'integrity:read'/);
  });

  it('Phase 12 rebuild requires localhost + the exact disposable database + the explicit flag + development mode before doing anything', () => {
    const text = source('src/scripts/phase12-rebuild-baseline.ts');
    const guard = text.slice(text.indexOf('if (!URI'), text.indexOf('@Module'));
    for (const needle of ["['127.0.0.1', 'localhost'].includes(", 'DB_NAME', "PHASE12_DISPOSABLE_DB !== '1'", "NODE_ENV !== 'development'"]) expect(guard).toContain(needle);
  });

  it('the legacy seed accepts PHASE12_DISPOSABLE_DB only for localhost + mazad_phase12_disposable / mazad_phase13_*, and only in a non-protected deployment', () => {
    const text = source('src/seeds/baseline-catalog.seed.ts');
    const branch = text.slice(text.indexOf('if (localDisposable) {'), text.indexOf('} else if (parsed.hostname !== EXPECTED_HOST)'));
    for (const needle of ["['127.0.0.1', 'localhost'].includes(parsed.hostname)", "localDb === 'mazad_phase12_disposable'", "startsWith('mazad_phase13_')", 'non-protected DEPLOYMENT_ENV']) expect(branch).toContain(needle);
  });

  it('both local E2E suites pin their target before creating the application and require NODE_ENV=development', () => {
    const phase12 = source('test/phase12-local-integration.spec.ts');
    expect(phase12).toContain("uri !== localUri");
    expect(phase12).toContain("process.env.NODE_ENV !== 'development'");
    const phase13 = source('test/phase13-local-e2e.spec.ts');
    expect(phase13.indexOf('assertDisposableTarget(uri)')).toBeLessThan(phase13.indexOf('Test.createTestingModule'));
    expect(phase13).toContain("process.env.DEPLOYMENT_ENV !== 'local'");
    expect(phase13).toContain("process.env.NODE_ENV !== 'development'");
  });
});
