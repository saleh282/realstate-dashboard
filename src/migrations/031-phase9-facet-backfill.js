'use strict';

const { ObjectId } = require('mongodb');
const { approvedFacets } = require('../domain/properties/property-form-write');
const { effectiveSpec } = require('../domain/properties/property-specifications');
const { facetsMatch } = require('./integrity-checker');
/**
 * Phase 9 (Search & Facets) backfill: recomputes `Property.facets` for every
 * property that already has a current public revision, using the exact same
 * `approvedFacets()` derivation approval uses. Existing properties approved
 * before the 7 facets were promoted (030) would otherwise stay permanently
 * invisible to facet search until their next unrelated re-approval.
 *
 * Never rewrites `property_revisions` (read-only source of truth); only ever
 * updates `Property.facets`, guarded per document against a concurrent
 * re-approval (`currentPublicRevisionId` must still match what was read).
 * Includes archived/admin-hidden properties for data consistency if later
 * restored; excludes properties with no current public revision (drafts,
 * never-approved) entirely, since they have nothing to derive facets from.
 */
const TARGET_FILTER = { currentPublicRevisionId: { $exists: true, $ne: null } };
function afterCheckpoint(checkpoint) {
  if (!checkpoint) return {};
  if (!ObjectId.isValid(checkpoint)) throw new RangeError('Stored migration checkpoint is invalid');
  return { _id: { $gt: new ObjectId(checkpoint) } };
}
async function loadTargetsWithRevisions(db, filter) {
  const properties = await db
    .collection('properties')
    .find(filter, { projection: { _id: 1, facets: 1, currentPublicRevisionId: 1 } })
    .sort({ _id: 1 })
    .toArray();
  const revisionIds = [...new Set(properties.map((property) => property.currentPublicRevisionId))];
  const revisions = revisionIds.length
    ? await db
        .collection('property_revisions')
        .find({ _id: { $in: revisionIds } })
        .toArray()
    : [];
  const revisionById = new Map(revisions.map((revision) => [String(revision._id), revision]));
  return { properties, revisionById };
}
/** Full-collection scan for preflight/validate; `migrateBatch` re-derives per batch instead (never loads the whole collection into one write pass). */
async function scanPhase9FacetBackfill(db) {
  const { properties, revisionById } = await loadTargetsWithRevisions(db, TARGET_FILTER);
  let eligible = 0;
  let alreadyCorrect = 0;
  for (const property of properties) {
    const revision = revisionById.get(String(property.currentPublicRevisionId));
    if (!revision) continue; // dangling currentPublicRevisionId: a separate, unrelated integrity concern.
    const expected = approvedFacets(effectiveSpec(revision).attributes);
    if (facetsMatch(property.facets, expected)) alreadyCorrect++;
    else eligible++;
  }
  return { totalTargets: properties.length, eligible, alreadyCorrect };
}
async function backfillPhase9FacetsBatch(db, checkpoint, batchSize) {
  const properties = db.collection('properties');
  const batch = await properties
    .find(
      { ...TARGET_FILTER, ...afterCheckpoint(checkpoint) },
      { projection: { _id: 1, facets: 1, currentPublicRevisionId: 1 } },
    )
    .sort({ _id: 1 })
    .limit(batchSize)
    .toArray();
  if (!batch.length) return { scanned: 0, modified: 0, done: true };
  const revisionIds = [...new Set(batch.map((property) => property.currentPublicRevisionId))];
  const revisions = await db
    .collection('property_revisions')
    .find({ _id: { $in: revisionIds } })
    .toArray();
  const revisionById = new Map(revisions.map((revision) => [String(revision._id), revision]));
  const ops = [];
  for (const property of batch) {
    const revision = revisionById.get(String(property.currentPublicRevisionId));
    if (!revision) continue; // dangling reference; not this migration's concern.
    const expected = approvedFacets(effectiveSpec(revision).attributes);
    if (facetsMatch(property.facets, expected)) continue; // idempotent: already correct, no write needed.
    // Concurrency guard: only writes if the property still points at the exact
    // revision this batch derived `expected` from; a concurrent re-approval
    // (which recomputes facets itself, correctly) simply wins and this no-ops.
    ops.push({
      updateOne: {
        filter: { _id: property._id, currentPublicRevisionId: property.currentPublicRevisionId },
        update: Object.keys(expected).length
          ? { $set: { facets: expected } }
          : { $unset: { facets: 1 } },
      },
    });
  }
  const result = ops.length
    ? await properties.bulkWrite(ops, { ordered: false })
    : { modifiedCount: 0 };
  return {
    scanned: batch.length,
    modified: result.modifiedCount ?? 0,
    checkpoint: String(batch[batch.length - 1]._id),
    done: batch.length < batchSize,
  };
}

Object.assign(exports, { scanPhase9FacetBackfill, backfillPhase9FacetsBatch });
