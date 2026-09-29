/** Read-only export of the catalog and current published forms needed to
 * reproduce the Phase 12 development baseline. No actor or property data is
 * included. The destination must not already exist. */
import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { computeFormContentHash } from '../property-form-definitions/property-form-definition.constants';
import { DEFAULT_CITIES } from '../governorates/governorate.constants';
import { storedContent } from '../property-form-definitions/form-definition-drafts';

async function main() {
  const uri = process.env.MONGO_URI;
  const output = process.argv[2];
  if (!uri || !output) throw new Error('Usage: MONGO_URI=... ts-node src/scripts/phase12-export-baseline.ts OUTPUT.json');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    const db = client.db();
    const [types, heads, governorates, cities, options] = await Promise.all([
      db.collection('property_types').find({}).toArray(),
      db.collection('property_form_definitions').find({}).toArray(),
      db.collection('governorates').find({}).toArray(),
      db.collection('cities').find({}).toArray(),
      db.collection('property_options').find({}).toArray(),
    ]);
    const versions = await db.collection('property_form_definition_versions')
      .find({ _id: { $in: heads.map((head) => head.currentVersionId).filter(Boolean) } }).toArray();
    const typeById = new Map(types.map((item) => [String(item._id), item]));
    const governorateById = new Map(governorates.map((item) => [String(item._id), item]));
    const versionById = new Map(versions.map((item) => [String(item._id), item]));
    const forms = heads.map((head) => {
      const type = typeById.get(String(head.purposeSubcategoryId));
      const version = versionById.get(String(head.currentVersionId));
      if (!type?.code || !version || head.status !== 'active' || version.state !== 'published') {
        throw new Error(`Incomplete current form for type ${String(head.purposeSubcategoryId)}`);
      }
      const content = storedContent(version as any);
      const contentHash = computeFormContentHash(content);
      if (contentHash !== version.contentHash) throw new Error(`Content hash mismatch for ${type.code}`);
      return { propertyTypeCode: type.code, contentHash, content };
    }).sort((a, b) => a.propertyTypeCode.localeCompare(b.propertyTypeCode));
    const pick = (item: any, keys: string[]) => Object.fromEntries(keys.filter((key) => item[key] !== undefined).map((key) => [key, item[key]]));
    const manifest = {
      schemaVersion: 1,
      expected: { purposes: 4, propertyTypes: 19, attributes: 27, amenities: 12, forms: 19 },
      propertyTypeCodes: types.map((item) => item.code).sort(),
      governorates: governorates.map((item) => pick(item, ['code', 'nameAr', 'nameEn', 'iconKey', 'isActive', 'sortOrder', 'mapViewport'])).sort((a, b) => a.code.localeCompare(b.code)),
      cities: cities.filter((item) => DEFAULT_CITIES.some(([governorate, code]) => code === item.code && governorate === governorateById.get(String(item.governorateId))?.code)).map((item) => ({
        governorateCode: governorateById.get(String(item.governorateId))?.code,
        ...pick(item, ['code', 'nameAr', 'nameEn', 'isActive', 'sortOrder']),
      })).sort((a, b) => `${a.governorateCode}:${String((a as Record<string, unknown>).code)}`.localeCompare(`${b.governorateCode}:${String((b as Record<string, unknown>).code)}`)),
      propertyOptions: options.map((item) => pick(item, ['group', 'code', 'nameAr', 'nameEn', 'descriptionAr', 'iconKey', 'isActive', 'isDefault', 'sortOrder']))
        .sort((a, b) => `${a.group}:${a.code}`.localeCompare(`${b.group}:${b.code}`)),
      forms,
    };
    if (manifest.cities.some((item) => !item.governorateCode)) throw new Error('City without a known governorate');
    if (types.length !== 19 || forms.length !== 19 || governorates.length !== 27 || manifest.cities.length !== DEFAULT_CITIES.length || options.length !== 12) {
      throw new Error('Catalog count differs from the verified Phase 12 source baseline');
    }
    await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    console.log(JSON.stringify({ output, forms: forms.length, governorates: governorates.length, cities: cities.length, propertyOptions: options.length }));
  } finally {
    await client.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, '[REDACTED_URI]') : 'Export failed');
  process.exitCode = 1;
});
