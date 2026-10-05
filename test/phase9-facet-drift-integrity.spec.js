'use strict';

const { ObjectId } = require('mongodb');
const { runIntegrityChecks } = require('../src/migrations/integrity-checker');
const { MemoryDb } = require('./support/memory-mongo');
/**
 * Phase 9 (Search & Facets) PROPERTY_FACET_DRIFT integrity check: compares
 * stored Property.facets against a fresh recomputation from the current
 * public revision. Read-only — never repairs.
 */
const oid = (n) => new ObjectId(`64c00000000000000000${'32'}${String(n).padStart(2, '0')}`);
function pinnedRevision(id, attributes) {
  return {
    _id: id,
    formDefinitionId: oid(1),
    formDefinitionVersionId: oid(2),
    formDefinitionVersion: 1,
    attributes,
  };
}
describe('PROPERTY_FACET_DRIFT integrity check', () => {
  it('reports nothing when every property has no current public revision', async () => {
    const db = new MemoryDb().seed('properties', [{ _id: oid(1) }]).seed('property_revisions', []);
    const report = await runIntegrityChecks(db, new Date('2026-01-01'));
    expect(
      report.findings.find((finding) => finding.code === 'PROPERTY_FACET_DRIFT'),
    ).toBeUndefined();
  });
  it('reports nothing (clean) when stored facets exactly match a recomputation from the current revision', async () => {
    const revision = pinnedRevision(oid(10), { soilType: 'clay', waterSource: 'well' });
    const db = new MemoryDb().seed('property_revisions', [revision]).seed('properties', [
      {
        _id: oid(20),
        status: 'approved',
        currentPublicRevisionId: revision._id,
        facets: { soilType: 'clay', waterSource: 'well' },
      },
    ]);
    const report = await runIntegrityChecks(db, new Date('2026-01-01'));
    expect(
      report.findings.find((finding) => finding.code === 'PROPERTY_FACET_DRIFT'),
    ).toBeUndefined();
    expect(report.ok).toBe(true);
  });
  it('order of a multiSelect facet array does not itself count as drift', async () => {
    const revision = pinnedRevision(oid(11), { commercialUseTypes: ['retail', 'food'] });
    const db = new MemoryDb().seed('property_revisions', [revision]).seed('properties', [
      {
        _id: oid(21),
        status: 'approved',
        currentPublicRevisionId: revision._id,
        facets: { commercialUseTypes: ['food', 'retail'] },
      },
    ]);
    const report = await runIntegrityChecks(db, new Date('2026-01-01'));
    expect(
      report.findings.find((finding) => finding.code === 'PROPERTY_FACET_DRIFT'),
    ).toBeUndefined();
  });
  it('reports drift as a warning (not an error) when stored facets are stale', async () => {
    const revision = pinnedRevision(oid(12), { soilType: 'clay' });
    const db = new MemoryDb().seed('property_revisions', [revision]).seed('properties', [
      {
        _id: oid(22),
        status: 'approved',
        currentPublicRevisionId: revision._id,
        facets: { soilType: 'sandy' },
      },
    ]);
    const report = await runIntegrityChecks(db, new Date('2026-01-01'));
    const finding = report.findings.find((f) => f.code === 'PROPERTY_FACET_DRIFT');
    expect(finding).toMatchObject({ severity: 'warning', count: 1, sampleIds: [String(oid(22))] });
    expect(report.ok).toBe(true); // warnings alone do not flip ok to false
    expect(report.warningCount).toBeGreaterThanOrEqual(1);
  });
  it('reports drift when facets are missing entirely but should be present', async () => {
    const revision = pinnedRevision(oid(13), { powerSource: 'grid' });
    const db = new MemoryDb()
      .seed('property_revisions', [revision])
      .seed('properties', [
        { _id: oid(23), status: 'approved', currentPublicRevisionId: revision._id },
      ]);
    const report = await runIntegrityChecks(db, new Date('2026-01-01'));
    expect(report.findings.find((f) => f.code === 'PROPERTY_FACET_DRIFT')).toMatchObject({
      count: 1,
      sampleIds: [String(oid(23))],
    });
  });
  it('does not flag an unrelated property whose facets have nothing promotable and correctly have no facets', async () => {
    const revision = pinnedRevision(oid(14), { plotShape: 'square' }); // presentation-only, not promoted
    const db = new MemoryDb()
      .seed('property_revisions', [revision])
      .seed('properties', [
        { _id: oid(24), status: 'approved', currentPublicRevisionId: revision._id },
      ]);
    const report = await runIntegrityChecks(db, new Date('2026-01-01'));
    expect(report.findings.find((f) => f.code === 'PROPERTY_FACET_DRIFT')).toBeUndefined();
  });
  it('never modifies the database (read-only)', async () => {
    const revision = pinnedRevision(oid(15), { soilType: 'clay' });
    const db = new MemoryDb().seed('property_revisions', [revision]).seed('properties', [
      {
        _id: oid(25),
        status: 'approved',
        currentPublicRevisionId: revision._id,
        facets: { soilType: 'sandy' },
      },
    ]);
    await runIntegrityChecks(db, new Date('2026-01-01'));
    expect(db.docs('properties').find((p) => String(p._id) === String(oid(25))).facets).toEqual({
      soilType: 'sandy',
    }); // untouched
    expect(db.writes).toEqual([]);
  });
});
