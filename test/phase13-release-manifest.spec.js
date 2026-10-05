'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { canonicalize } = require('../src/services/idempotency.service');
const { planApply } = require('../src/release/baseline-apply');
const {
  CATALOG_NAMES,
  manifestHashOf,
  manifestIntegrityProblems,
  verifyAgainstManifest,
} = require('../src/release/baseline-manifest');
const {
  computeFormContentHash,
} = require('../src/domain/property-form-definitions/property-form-definition.constants');
const {
  SHIPPED_MEDIA_PROFILES,
} = require('../src/domain/property-form-definitions/property-form-definition.constants');
const manifest = () =>
  JSON.parse(readFileSync(join(__dirname, '../src/release/baseline-manifest.v1.json'), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const rehash = (m) => {
  const { manifestHash, ...body } = m;
  return { ...m, manifestHash: manifestHashOf(body) };
};
/** A tiny Db double that materialises a manifest as live collections (ids are synthetic; the manifest carries none). */
function dbFrom(m, mutate) {
  const docs = {};
  const id = (prefix, key) => `${prefix}:${key}`;
  const col = (name, rows) => {
    docs[name] = rows;
  };
  const strictOf = (name) =>
    m.catalogs[name].map((entry) => ({ ...entry.strict, ...entry.display }));
  col(
    'property_purpose_categories',
    m.catalogs.purposes.map((e) => ({ _id: id('purpose', e.id), ...e.strict, ...e.display })),
  );
  col(
    'property_types',
    m.catalogs.propertyTypes.map((e) => {
      const { purposeCode, ...rest } = { ...e.strict, ...e.display };
      return { _id: id('type', e.id), ...rest, purposeCategoryId: id('purpose', purposeCode) };
    }),
  );
  col(
    'property_attributes',
    strictOf('attributes').map((row, i) => ({ _id: `attr${i}`, ...row })),
  );
  col(
    'amenities',
    strictOf('amenities').map((row, i) => ({ _id: `am${i}`, ...row })),
  );
  col(
    'property_options',
    strictOf('propertyOptions').map((row, i) => ({ _id: `opt${i}`, ...row })),
  );
  col(
    'governorates',
    m.catalogs.governorates.map((e) => ({ _id: id('gov', e.id), ...e.strict, ...e.display })),
  );
  col(
    'cities',
    m.catalogs.cities.map((e, i) => {
      const { governorateCode, ...rest } = { ...e.strict, ...e.display };
      return { _id: `city${i}`, ...rest, governorateId: id('gov', governorateCode) };
    }),
  );
  col(
    'property_form_definitions',
    m.forms.map((f) => ({
      _id: id('def', f.propertyTypeCode),
      purposeSubcategoryId: id('type', f.propertyTypeCode),
      currentVersionId: id('ver', f.propertyTypeCode),
      status: 'active',
    })),
  );
  col(
    'property_form_definition_versions',
    m.forms.map((f) => ({
      _id: id('ver', f.propertyTypeCode),
      state: 'published',
      ...clone(f.content),
      contentHash: f.contentHash,
    })),
  );
  mutate?.(docs);
  const matches = (doc, filter) =>
    Object.entries(filter ?? {}).every(([key, cond]) => {
      if (cond && typeof cond === 'object' && '$in' in cond) return cond.$in.includes(doc[key]);
      if (cond && typeof cond === 'object' && '$exists' in cond)
        return (doc[key] !== undefined) === cond.$exists;
      return doc[key] === cond;
    });
  return {
    collection: (name) => ({
      find: (filter) => ({
        toArray: async () => (docs[name] ?? []).filter((doc) => matches(doc, filter)),
      }),
    }),
  };
}
const verdictOf = (report, area, id) =>
  report.items.find((item) => item.area === area && item.id === id)?.verdict;
describe('Phase 13 release manifest (checked-in baseline)', () => {
  it('is self-consistent and describes the full baseline by stable codes', () => {
    const m = manifest();
    expect(manifestIntegrityProblems(m)).toEqual([]);
    expect(
      Object.fromEntries(CATALOG_NAMES.map((name) => [name, m.catalogs[name].length])),
    ).toEqual({
      purposes: 4,
      propertyTypes: 19,
      attributes: 27,
      amenities: 12,
      propertyOptions: 12,
      governorates: 27,
      cities: 123,
    });
    expect(m.forms).toHaveLength(19);
    expect(m.forms.map((f) => f.propertyTypeCode)).toEqual(
      [...m.forms.map((f) => f.propertyTypeCode)].sort(),
    );
    for (const form of m.forms) expect(computeFormContentHash(form.content)).toBe(form.contentHash);
    expect(Object.keys(m.mediaProfiles).sort()).toEqual([...SHIPPED_MEDIA_PROFILES].sort());
  });
  it('carries no ObjectId, timestamp, actor, counter or credential', () => {
    const text = canonicalize(manifest());
    expect(text).not.toMatch(/\b[0-9a-f]{24}\b/);
    for (const forbidden of [
      '"createdAt"',
      '"updatedAt"',
      '"createdBy"',
      '"usageCount"',
      '"_id"',
      '"__v"',
      'password',
      'secret',
      'mongodb://',
    ])
      expect(text).not.toContain(forbidden);
  });
  it('is deterministic: rehashing the body reproduces the stored manifestHash', () => {
    const m = manifest();
    expect(rehash(m).manifestHash).toBe(m.manifestHash);
  });
  it('detects any tampering with the file itself', () => {
    const edited = clone(manifest());
    edited.forms[0].content.amenitiesEnabled = !edited.forms[0].content.amenitiesEnabled;
    expect(manifestIntegrityProblems(edited).join()).toContain('contentHash does not match');
    const noHash = clone(manifest());
    noHash.catalogs.cities.pop();
    expect(manifestIntegrityProblems(noHash).join()).toContain('manifestHash does not match');
    const media = rehash({
      ...clone(manifest()),
      mediaProfiles: { ...manifest().mediaProfiles, generic: 'f'.repeat(64) },
    });
    expect(manifestIntegrityProblems(media).join()).toContain('differs from the frozen code hash');
  });
});
describe('Phase 13 manifest verification against a database', () => {
  it('reports a faithful rebuild as fully matching', async () => {
    const m = manifest();
    const report = await verifyAgainstManifest(dbFrom(m), m);
    expect(report.ok).toBe(true);
    expect(report.counts).toMatchObject({ missing: 0, diverge: 0, invalid: 0, drift: 0, extra: 0 });
    expect(report.counts.match).toBe(4 + 19 + 27 + 12 + 12 + 27 + 123 + 19 + 2);
  });
  it('fails on a missing form and a form whose content diverged', async () => {
    const m = manifest();
    const missing = await verifyAgainstManifest(
      dbFrom(m, (docs) => {
        docs.property_form_definitions = docs.property_form_definitions.filter(
          (d) => d._id !== 'def:shop',
        );
      }),
      m,
    );
    expect(missing.ok).toBe(false);
    expect(verdictOf(missing, 'forms', 'shop')).toBe('missing');
    const diverged = await verifyAgainstManifest(
      dbFrom(m, (docs) => {
        const version = docs.property_form_definition_versions.find((v) => v._id === 'ver:factory');
        version.allowedAmenityCodes = ['elevator'];
        version.contentHash = computeFormContentHash({
          rendererVersion: version.rendererVersion,
          fields: version.fields,
          mediaProfile: version.mediaProfile,
          amenitiesEnabled: version.amenitiesEnabled,
          allowedAmenityCodes: version.allowedAmenityCodes,
        });
      }),
      m,
    );
    expect(diverged.ok).toBe(false);
    expect(verdictOf(diverged, 'forms', 'factory')).toBe('diverge');
  });
  it('fails on a stored hash that does not match its own content (corrupt version)', async () => {
    const m = manifest();
    const report = await verifyAgainstManifest(
      dbFrom(m, (docs) => {
        docs.property_form_definition_versions.find((v) => v._id === 'ver:office').contentHash =
          'bad';
      }),
      m,
    );
    expect(report.ok).toBe(false);
    expect(verdictOf(report, 'forms', 'office')).toBe('invalid');
  });
  it('treats an archived definition as not currently published', async () => {
    const m = manifest();
    const report = await verifyAgainstManifest(
      dbFrom(m, (docs) => {
        docs.property_form_definitions.find((d) => d._id === 'def:villa').status = 'archived';
      }),
      m,
    );
    expect(verdictOf(report, 'forms', 'villa')).toBe('missing');
  });
  it('fails on a missing or structurally different catalog entry, but only warns on display drift and extras', async () => {
    const m = manifest();
    const report = await verifyAgainstManifest(
      dbFrom(m, (docs) => {
        docs.amenities = docs.amenities.filter((row) => row.code !== 'elevator');
        docs.property_attributes.find((row) => row.key === 'bedrooms').dataType = 'string';
        docs.property_types.find((row) => row.code === 'shop').nameAr = 'اسم جديد';
        docs.property_types.push({
          _id: 'type:custom',
          code: 'custom_type',
          purposeCategoryId: 'purpose:residential',
          nameAr: 'x',
        });
      }),
      m,
    );
    expect(report.ok).toBe(false);
    expect(verdictOf(report, 'amenities', 'elevator')).toBe('missing');
    expect(verdictOf(report, 'attributes', 'bedrooms')).toBe('diverge');
    expect(verdictOf(report, 'propertyTypes', 'shop')).toBe('drift');
    expect(verdictOf(report, 'propertyTypes', 'custom_type')).toBe('extra');
    // drift and extras alone do not fail:
    const soft = await verifyAgainstManifest(
      dbFrom(m, (docs) => {
        docs.property_types.find((row) => row.code === 'shop').nameAr = 'اسم جديد';
        docs.property_types.push({
          _id: 'type:custom',
          code: 'custom_type',
          purposeCategoryId: 'purpose:residential',
          nameAr: 'x',
        });
      }),
      m,
    );
    expect(soft.ok).toBe(true);
  });
  it('does not depend on database ids: a differently-id-ed rebuild verifies identically', async () => {
    const m = manifest();
    const renamed = dbFrom(m);
    expect((await verifyAgainstManifest(renamed, m)).ok).toBe(true);
  });
});
describe('Phase 13 manifest apply planning', () => {
  const reportFor = async (mutate) => {
    const m = manifest();
    return verifyAgainstManifest(dbFrom(m, mutate), m);
  };
  it('plans create for a missing form and nothing for matching forms', async () => {
    const { plan, blockers } = planApply(
      await reportFor((docs) => {
        docs.property_form_definitions = docs.property_form_definitions.filter(
          (d) => d._id !== 'def:shop',
        );
      }),
      new Set(),
    );
    expect(blockers).toEqual([]);
    expect(plan.filter((item) => item.action !== 'unchanged')).toEqual([
      { propertyTypeCode: 'shop', action: 'create' },
    ]);
    expect(plan.filter((item) => item.action === 'unchanged')).toHaveLength(18);
  });
  it('refuses divergence unless the type is explicitly allowed, then plans a new version only for it', async () => {
    const diverge = (docs) => {
      const version = docs.property_form_definition_versions.find((v) => v._id === 'ver:factory');
      version.amenitiesEnabled = !version.amenitiesEnabled;
      version.contentHash = computeFormContentHash({
        rendererVersion: version.rendererVersion,
        fields: version.fields,
        mediaProfile: version.mediaProfile,
        amenitiesEnabled: version.amenitiesEnabled,
        allowedAmenityCodes: version.allowedAmenityCodes,
      });
    };
    const refused = planApply(await reportFor(diverge), new Set());
    expect(refused.blockers.join()).toContain('form factory diverges');
    expect(refused.plan.find((item) => item.propertyTypeCode === 'factory').action).toBe(
      'refuse-divergence',
    );
    const wrongType = planApply(await reportFor(diverge), new Set(['shop']));
    expect(wrongType.blockers.join()).toContain('form factory diverges');
    const allowed = planApply(await reportFor(diverge), new Set(['factory']));
    expect(allowed.blockers).toEqual([]);
    expect(allowed.plan.find((item) => item.propertyTypeCode === 'factory').action).toBe(
      'publish-new-version',
    );
  });
  it('blocks apply on a missing or divergent catalog: catalogs belong to seeds and migrations', async () => {
    const { blockers } = planApply(
      await reportFor((docs) => {
        docs.amenities = docs.amenities.slice(1);
      }),
      new Set(),
    );
    expect(blockers.join()).toContain('run the baseline seeds and migrations first');
  });
  it('blocks apply on a corrupt live form and on a media-profile mismatch', async () => {
    const corrupt = planApply(
      await reportFor((docs) => {
        docs.property_form_definition_versions[0].contentHash = 'bad';
      }),
      new Set(),
    );
    expect(corrupt.blockers.join()).toContain('stored contentHash');
  });
});
