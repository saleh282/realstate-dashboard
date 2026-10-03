import { MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AppModule } from '../src/app.module';
import { selectMigrations } from '../src/migrations/cli';
import { CORE_MIGRATIONS } from '../src/migrations/framework/core-migrations';
import { managedMarketingPaymentIndexesMigration, MANAGED_MARKETING_PAYMENT_INDEXES } from '../src/migrations/038-managed-marketing-payment-indexes';
import { MigrationRunner } from '../src/migrations/framework/migration.runner';
import { MemoryDb, MemoryStore } from './support/memory-mongo';

function moduleGraph(root: any) {
  const seen = new Set<any>();
  function visit(imported: any) {
    if (!imported || imported instanceof Promise) return;
    const module = imported.module ?? imported;
    if (seen.has(module)) return;
    seen.add(module);
    for (const child of [...(Reflect.getMetadata(MODULE_METADATA.IMPORTS, module) ?? []), ...(imported.imports ?? [])]) visit(child);
  }
  visit(root);
  return [...seen];
}

describe('removed feature boundaries', () => {
  it('keeps property, auth, users, marketing and notifications reachable without registering auction controllers or modules', () => {
    const modules = moduleGraph(AppModule);
    const names = modules.map((module) => module.name);
    expect(names).toEqual(expect.arrayContaining(['PropertiesModule', 'AuthModule', 'UsersModule', 'ManagedMarketingModule', 'PaymentsModule', 'NotificationsModule']));
    expect(names.join(' ')).not.toMatch(/Auction|BidsModule|RealtimeModule/);
    const paths = modules.flatMap((module) => Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, module) ?? [])
      .map((controller) => Reflect.getMetadata(PATH_METADATA, controller));
    expect(paths).toEqual(expect.arrayContaining(['properties', 'auth', 'users', 'notifications']));
    expect(paths.join(' ')).not.toMatch(/auction|realtime/);
  });

  it('excludes frozen auction/mixed migrations from default runs and retains explicit historical access', () => {
    const defaults = selectMigrations(CORE_MIGRATIONS).map((migration) => migration.id);
    expect(defaults).toContain('038-managed-marketing-payment-indexes');
    expect(defaults).not.toContain('036-mazad035-auction-review-indexes');
    expect(defaults).not.toContain('037-mazad028-payment-lifecycle-indexes');
    expect(CORE_MIGRATIONS.find((migration) => migration.id.startsWith('036-'))).toMatchObject({ version: 1, manualOnly: true });
  });
});

describe('retained payment index migration', () => {
  function database(duplicates = false) {
    const db = new MemoryDb();
    const collection = db.collection.bind(db);
    db.collection = ((name: string) => ({ ...collection(name), aggregate: () => ({ toArray: async () => duplicates ? [{ count: 2 }] : [] }) })) as any;
    return db;
  }

  it('dry-runs without writes, applies only marketing indexes, validates, and skips a completed rerun', async () => {
    const db = database();
    const store = new MemoryStore();
    const runner = new MigrationRunner(db as any, store);
    expect((await runner.run(managedMarketingPaymentIndexesMigration, 'dry-run')).preflight.blockers).toEqual([]);
    expect(db.writes).toEqual([]);
    expect((await runner.run(managedMarketingPaymentIndexesMigration, 'apply')).validation.valid).toBe(true);
    expect(db.writes).toHaveLength(MANAGED_MARKETING_PAYMENT_INDEXES.length);
    expect(db.writes.every((write) => write.collection === 'managed_marketing_payments' && write.op === 'createIndex')).toBe(true);
    expect((await runner.run(managedMarketingPaymentIndexesMigration, 'apply')).status).toBe('skipped-complete');
  });

  it('blocks duplicates before creating safety indexes', async () => {
    const result = await managedMarketingPaymentIndexesMigration.preflight({ db: database(true) as any, runId: 'test', batchSize: 100 });
    expect(result.blockers.map((blocker) => blocker.code)).toContain('MARKETING_PAYMENT_DUPLICATE_KEY');
  });

  it('blocks conflicting index options rather than replacing an existing safety index', async () => {
    const db = database();
    const spec = MANAGED_MARKETING_PAYMENT_INDEXES.find((index) => index.options.unique)!;
    db.indexes.set(spec.collection, [{ key: spec.key, name: spec.options.name, unique: false }]);
    const result = await managedMarketingPaymentIndexesMigration.preflight({ db: db as any, runId: 'test', batchSize: 100 });
    expect(result.blockers.map((blocker) => blocker.code)).toContain('MARKETING_PAYMENT_INDEX_CONFLICT');
    expect(db.writes).toEqual([]);
  });
});
