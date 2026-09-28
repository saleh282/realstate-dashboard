import { ObjectId } from 'mongodb';
import { phase9FacetBackfillMigration } from '../src/migrations/framework/core-migrations';
import { MigrationRunner } from '../src/migrations/framework/migration.runner';
import { backfillPhase9FacetsBatch, scanPhase9FacetBackfill } from '../src/migrations/031-phase9-facet-backfill';
import { MemoryDb, MemoryStore } from './support/memory-mongo';

/**
 * Phase 9 (Search & Facets) facet backfill (031-phase9-facet-backfill):
 * recomputes Property.facets for already-approved properties from their
 * current public revision, using the same approvedFacets() derivation
 * approval uses. Never rewrites property_revisions.
 */
const oid = (n: number) => new ObjectId(`64c0000000000000000031${String(n).padStart(2, '0')}`);
const runner = (db: MemoryDb, store = new MemoryStore(), batchSize = 250) => new MigrationRunner(db as any, store, { batchSize });
const completed = (...ids: string[]) => { const store = new MemoryStore(); for (const id of ids) store.markComplete(id); return store; };

function pinnedRevision(id: ObjectId, attributes: Record<string, unknown>) {
  return { _id: id, formDefinitionId: oid(90), formDefinitionVersionId: oid(91), formDefinitionVersion: 1, attributes };
}

describe('Phase 9 facet backfill (031-phase9-facet-backfill)', () => {
  it('depends on 030-phase9-facet-promotion', () => {
    expect(phase9FacetBackfillMigration.dependencies).toEqual(['030-phase9-facet-promotion']);
  });

  it('targets only properties with a current public revision: visible, archived and admin-hidden alike; excludes drafts with no public revision', async () => {
    const revision1 = pinnedRevision(oid(1), { shopFloorLevel: 'ground', commercialUseTypes: ['retail'] });
    const db = new MemoryDb()
      .seed('property_revisions', [revision1])
      .seed('properties', [
        { _id: oid(10), lifecycleStatus: 'active', currentPublicRevisionId: revision1._id },
        { _id: oid(11), lifecycleStatus: 'archived', currentPublicRevisionId: revision1._id },
        { _id: oid(12), lifecycleStatus: 'admin_hidden', currentPublicRevisionId: revision1._id },
        { _id: oid(13), lifecycleStatus: 'active', currentPublicRevisionId: null }, // draft, never approved
        { _id: oid(14), lifecycleStatus: 'active' }, // no field at all
      ]);
    const scan = await scanPhase9FacetBackfill(db as any);
    expect(scan.totalTargets).toBe(3);
    expect(scan.eligible).toBe(3);

    await runner(db, completed('030-phase9-facet-promotion')).run(phase9FacetBackfillMigration, 'apply');
    for (const id of [oid(10), oid(11), oid(12)]) {
      expect(db.docs('properties').find((property) => String(property._id) === String(id))!.facets).toEqual({ shopFloorLevel: 'ground', commercialUseTypes: ['retail'] });
    }
    expect(db.docs('properties').find((property) => String(property._id) === String(oid(13)))!.facets).toBeUndefined();
    expect(db.docs('properties').find((property) => String(property._id) === String(oid(14)))!.facets).toBeUndefined();
  });

  it('sets missing facets, corrects stale facets, and leaves already-matching facets untouched', async () => {
    const revision = pinnedRevision(oid(2), { soilType: 'clay', waterSource: 'well' });
    const db = new MemoryDb()
      .seed('property_revisions', [revision])
      .seed('properties', [
        { _id: oid(20), currentPublicRevisionId: revision._id }, // missing facets
        { _id: oid(21), currentPublicRevisionId: revision._id, facets: { soilType: 'sandy', waterSource: 'well' } }, // stale
        { _id: oid(22), currentPublicRevisionId: revision._id, facets: { soilType: 'clay', waterSource: 'well' } }, // already correct
      ]);
    const result = await backfillPhase9FacetsBatch(db as any, undefined, 250);
    expect(result.modified).toBe(2); // only the missing + stale ones
    expect(db.docs('properties').find((p) => String(p._id) === String(oid(20)))!.facets).toEqual({ soilType: 'clay', waterSource: 'well' });
    expect(db.docs('properties').find((p) => String(p._id) === String(oid(21)))!.facets).toEqual({ soilType: 'clay', waterSource: 'well' });
    expect(db.docs('properties').find((p) => String(p._id) === String(oid(22)))!.facets).toEqual({ soilType: 'clay', waterSource: 'well' });
  });

  it('unsets facets when the revision has nothing promotable (whole-object replace, same as approval)', async () => {
    const revision = pinnedRevision(oid(3), { plotShape: 'square' }); // presentation-only, not promoted
    const db = new MemoryDb()
      .seed('property_revisions', [revision])
      .seed('properties', [{ _id: oid(30), currentPublicRevisionId: revision._id, facets: { soilType: 'clay' } }]);
    await backfillPhase9FacetsBatch(db as any, undefined, 250);
    expect(db.docs('properties').find((p) => String(p._id) === String(oid(30)))!.facets).toBeUndefined();
  });

  it('is idempotent: a second run over an already-backfilled set modifies nothing', async () => {
    const revision = pinnedRevision(oid(4), { powerSource: 'grid' });
    const db = new MemoryDb()
      .seed('property_revisions', [revision])
      .seed('properties', [{ _id: oid(40), currentPublicRevisionId: revision._id }]);
    const first = await backfillPhase9FacetsBatch(db as any, undefined, 250);
    expect(first.modified).toBe(1);
    const second = await backfillPhase9FacetsBatch(db as any, undefined, 250);
    expect(second.modified).toBe(0);
  });

  it('never writes to property_revisions (revisions stay byte-identical)', async () => {
    const revision = pinnedRevision(oid(5), { industrialUseType: 'light' });
    const before = JSON.stringify(revision);
    const db = new MemoryDb()
      .seed('property_revisions', [revision])
      .seed('properties', [{ _id: oid(50), currentPublicRevisionId: revision._id }]);
    await backfillPhase9FacetsBatch(db as any, undefined, 250);
    expect(JSON.stringify(db.docs('property_revisions').find((r) => String(r._id) === String(revision._id)))).toBe(before);
    expect(db.writes.some((write) => write.collection === 'property_revisions' && write.op !== undefined && ['updateOne', 'updateMany', 'bulkWrite', 'insertOne'].includes(write.op))).toBe(false);
  });

  it('is concurrent-write-safe: each write is guarded by the exact currentPublicRevisionId read for that property', async () => {
    const revision = pinnedRevision(oid(6), { waterSource: 'canal' });
    const db = new MemoryDb().seed('property_revisions', [revision]).seed('properties', [{ _id: oid(60), currentPublicRevisionId: revision._id }]);
    const rawCollection = db.collection('properties');
    const seenFilters: any[] = [];
    const spiedDb = { collection: (name: string) => (name === 'properties' ? { ...rawCollection, bulkWrite: async (ops: any[]) => { seenFilters.push(...ops.map((op) => op.updateOne.filter)); return rawCollection.bulkWrite(ops); } } : db.collection(name)) };
    await backfillPhase9FacetsBatch(spiedDb as any, undefined, 250);
    expect(seenFilters).toEqual([{ _id: oid(60), currentPublicRevisionId: revision._id }]);
    // A concurrent re-approval that changed currentPublicRevisionId before this write landed would make this exact filter miss, leaving the fresher write (which itself recomputed correctly) untouched.
  });

  it('dry-run reports eligible/alreadyCorrect counts and performs no writes', async () => {
    const revision = pinnedRevision(oid(7), { shopFloorLevel: 'upper' });
    const db = new MemoryDb()
      .seed('property_revisions', [revision])
      .seed('properties', [
        { _id: oid(70), currentPublicRevisionId: revision._id },
        { _id: oid(71), currentPublicRevisionId: revision._id, facets: { shopFloorLevel: 'upper' } },
      ]);
    const dryRun = await runner(db, completed('030-phase9-facet-promotion')).run(phase9FacetBackfillMigration, 'dry-run');
    expect(dryRun.preflight).toMatchObject({ eligible: 1, alreadyApplied: 1 });
    expect(db.writes).toEqual([]);
  });

  it('validate() fails while drift remains and passes once the backfill completes', async () => {
    const revision = pinnedRevision(oid(8), { soilType: 'mixed' });
    const db = new MemoryDb().seed('property_revisions', [revision]).seed('properties', [{ _id: oid(80), currentPublicRevisionId: revision._id }]);
    const before = await phase9FacetBackfillMigration.validate({ db: db as any, runId: 'r', batchSize: 250 });
    expect(before.valid).toBe(false);
    await runner(db, completed('030-phase9-facet-promotion')).run(phase9FacetBackfillMigration, 'apply');
    const after = await phase9FacetBackfillMigration.validate({ db: db as any, runId: 'r', batchSize: 250 });
    expect(after.valid).toBe(true);
  });

  it('checkpoints across batches (batchSize smaller than the target set)', async () => {
    const revisions = [pinnedRevision(oid(9), { soilType: 'clay' }), pinnedRevision(oid(10), { soilType: 'sandy' })];
    const db = new MemoryDb()
      .seed('property_revisions', revisions)
      .seed('properties', [
        { _id: oid(90), currentPublicRevisionId: revisions[0]._id },
        { _id: oid(91), currentPublicRevisionId: revisions[1]._id },
      ]);
    const result = await runner(db, completed('030-phase9-facet-promotion'), 1).run(phase9FacetBackfillMigration, 'apply');
    expect(result.status).toBe('complete');
    expect(result.batches).toBeGreaterThanOrEqual(2);
    expect(result.modified).toBe(2);
  });

  it('ignores a property with a dangling currentPublicRevisionId (a separate, unrelated integrity concern)', async () => {
    const dangling = new ObjectId('64c000000000000000009999');
    const db = new MemoryDb().seed('property_revisions', []).seed('properties', [{ _id: oid(99), currentPublicRevisionId: dangling }]);
    const result = await backfillPhase9FacetsBatch(db as any, undefined, 250);
    expect(result.modified).toBe(0);
    expect(db.docs('properties')[0].facets).toBeUndefined();
  });
});
