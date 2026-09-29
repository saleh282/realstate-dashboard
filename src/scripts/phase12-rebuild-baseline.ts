/** Replays the read-only Phase 12 snapshot into a disposable localhost database.
 * Run after SUPER_ADMIN bootstrap, baseline-catalog pre/post seeds and migrations.
 * Published non-residential forms go through the real Admin draft lifecycle.
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { AdminPropertyFormDefinitionsService } from '../property-form-definitions/admin-property-form-definitions.service';
import { PropertyFormDefinitionsModule } from '../property-form-definitions/property-form-definitions.module';
import { computeFormContentHash, type FormVersionContent } from '../property-form-definitions/property-form-definition.constants';
import { DEFAULT_CITIES } from '../governorates/governorate.constants';
import type { FormFieldDto } from '../property-form-definitions/dto/admin-form-definition.dto';

const URI = process.env.MONGO_URI;
const DB_NAME = 'mazad_phase12_disposable';
const SNAPSHOT = join(__dirname, '../seeds/phase12-baseline.snapshot.json');

if (!URI || !['127.0.0.1', 'localhost'].includes(new URL(URI).hostname)
  || new URL(URI).pathname.slice(1) !== DB_NAME
  || process.env.PHASE12_DISPOSABLE_DB !== '1'
  || process.env.NODE_ENV !== 'development') {
  throw new Error('Refused: Phase 12 replay requires explicit development mode and localhost/mazad_phase12_disposable');
}

@Module({ imports: [MongooseModule.forRoot(URI), PropertyFormDefinitionsModule] })
class ReplayModule {}

type CatalogRow = Record<string, any> & { code: string };
type Snapshot = {
  schemaVersion: number;
  expected: { purposes: number; propertyTypes: number; attributes: number; amenities: number; forms: number };
  propertyTypeCodes: string[];
  governorates: CatalogRow[];
  cities: Array<CatalogRow & { governorateCode: string }>;
  propertyOptions: Array<CatalogRow & { group: string }>;
  forms: Array<{ propertyTypeCode: string; contentHash: string; content: FormVersionContent }>;
};

function assertUnique(values: string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label} in snapshot`);
}

async function main() {
  const snapshot = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as Snapshot;
  if (snapshot.schemaVersion !== 1 || snapshot.expected.purposes !== 4 || snapshot.expected.propertyTypes !== 19
    || snapshot.expected.attributes !== 27 || snapshot.expected.amenities !== 12 || snapshot.expected.forms !== 19
    || snapshot.governorates.length !== 27 || snapshot.cities.length !== DEFAULT_CITIES.length || snapshot.propertyOptions.length !== 12
    || snapshot.forms.length !== 19 || snapshot.propertyTypeCodes.length !== 19) {
    throw new Error('Unexpected Phase 12 snapshot shape or counts');
  }
  assertUnique(snapshot.propertyTypeCodes, 'property type');
  assertUnique(snapshot.governorates.map((row) => row.code), 'governorate');
  assertUnique(snapshot.cities.map((row) => `${row.governorateCode}:${row.code}`), 'city');
  const owned = new Set(DEFAULT_CITIES.map(([governorateCode, code]) => `${governorateCode}:${code}`));
  if (snapshot.cities.some((row) => !owned.has(`${row.governorateCode}:${row.code}`))) throw new Error('Snapshot contains a city outside code-owned DEFAULT_CITIES');
  assertUnique(snapshot.propertyOptions.map((row) => `${row.group}:${row.code}`), 'property option');
  assertUnique(snapshot.forms.map((row) => row.propertyTypeCode), 'form');
  if (snapshot.forms.some((row) => !snapshot.propertyTypeCodes.includes(row.propertyTypeCode)
    || computeFormContentHash(row.content) !== row.contentHash)) throw new Error('Snapshot form content hash or type mismatch');

  const app = await NestFactory.createApplicationContext(ReplayModule, { logger: ['error'] });
  try {
    const connection = app.get<Connection>(getConnectionToken());
    const db = connection.db;
    if (!db || db.databaseName !== DB_NAME) throw new Error('Connected to unexpected database');
    const admin = await db.collection('users').findOne({ systemRole: 'SUPER_ADMIN' }, { projection: { _id: 1 } });
    if (!admin?._id) throw new Error('Local SUPER_ADMIN bootstrap is missing');
    const actor = { userId: String(admin._id) };
    const now = new Date();
    const metadata = { usageCount: 0, createdBy: admin._id, updatedBy: admin._id, createdAt: now, updatedAt: now };

    const [purposes, types, attributes, amenities] = await Promise.all([
      db.collection('property_purpose_categories').find({}).toArray(),
      db.collection('property_types').find({}).toArray(),
      db.collection('property_attributes').find({}).toArray(),
      db.collection('amenities').find({}).toArray(),
    ]);
    if (purposes.length !== 4 || types.length !== 19 || attributes.length !== 27 || amenities.length !== 12
      || types.some((type) => !snapshot.propertyTypeCodes.includes(type.code))) {
      throw new Error('Seeded purposes, types, attributes, or amenities do not match the snapshot');
    }
    const typeByCode = new Map(types.map((type) => [type.code as string, type]));
    const residentialPurpose = purposes.find((purpose) => purpose.code === 'residential');
    if (!residentialPurpose) throw new Error('Residential purpose missing');

    for (const row of snapshot.governorates) {
      await db.collection('governorates').updateOne({ code: row.code }, { $setOnInsert: { ...row, ...metadata } }, { upsert: true });
    }
    const governorates = await db.collection('governorates').find({}).toArray();
    const governorateByCode = new Map(governorates.map((row) => [row.code as string, row]));
    for (const { governorateCode, ...row } of snapshot.cities) {
      const governorate = governorateByCode.get(governorateCode);
      if (!governorate) throw new Error(`Missing governorate for city ${row.code}`);
      await db.collection('cities').updateOne(
        { governorateId: governorate._id, code: row.code },
        { $setOnInsert: { ...row, governorateId: governorate._id, ...metadata } },
        { upsert: true },
      );
    }
    for (const row of snapshot.propertyOptions) {
      await db.collection('property_options').updateOne(
        { group: row.group, code: row.code }, { $setOnInsert: { ...row, ...metadata } }, { upsert: true },
      );
    }

    const service = app.get(AdminPropertyFormDefinitionsService);
    let residentialVerified = 0;
    let nonResidentialPublished = 0;
    let alreadyMatching = 0;
    for (const row of snapshot.forms) {
      const type = typeByCode.get(row.propertyTypeCode);
      if (!type) throw new Error(`Missing type ${row.propertyTypeCode}`);
      const existing = await db.collection('property_form_definitions').findOne({ purposeSubcategoryId: type._id });
      if (String(type.purposeCategoryId) === String(residentialPurpose._id)) {
        if (!existing?.currentVersionId) throw new Error(`Residential published form missing: ${row.propertyTypeCode}`);
        const version = await db.collection('property_form_definition_versions').findOne({ _id: existing.currentVersionId });
        if (version?.contentHash !== row.contentHash) throw new Error(`Residential hash mismatch: ${row.propertyTypeCode}`);
        residentialVerified++;
        continue;
      }
      if (existing?.currentVersionId) {
        const version = await db.collection('property_form_definition_versions').findOne({ _id: existing.currentVersionId });
        if (version?.contentHash !== row.contentHash) throw new Error(`Non-residential hash conflict: ${row.propertyTypeCode}`);
        alreadyMatching++;
        continue;
      }
      const detail = existing
        ? await service.getDefinition(String(existing._id))
        : await service.createDefinition({ purposeSubcategoryId: String(type._id) }, actor);
      const definitionId = detail.definition.definitionId;
      const draftRevision = detail.draft?.draftRevision;
      if (draftRevision == null) throw new Error(`Draft missing: ${row.propertyTypeCode}`);
      // Identity properties are owned by the Attribute Registry and rebuilt by
      // Admin updateDraft. Send only its editable transport fields.
      const editableFields = row.content.fields.map((field) => {
        const { key, labelAr, labelEn, helpAr, helpEn, placeholderAr, required, order, operations, widget, validation, options } = field;
        return { key, labelAr, labelEn, helpAr, helpEn, placeholderAr, required, order, operations, widget, validation, options } as FormFieldDto;
      });
      const saved = await service.updateDraft(definitionId, {
        expectedDraftRevision: draftRevision, fields: editableFields, mediaProfile: row.content.mediaProfile,
        amenitiesEnabled: row.content.amenitiesEnabled,
        ...(row.content.allowedAmenityCodes !== undefined ? { allowedAmenityCodes: row.content.allowedAmenityCodes } : {}),
      }, actor);
      const validation = await service.validateDraft(definitionId);
      if (!validation.valid || validation.contentHash !== row.contentHash) {
        throw new Error(`Replayed draft differs for ${row.propertyTypeCode}: ${JSON.stringify(validation.errors)}`);
      }
      await service.publish(definitionId, {
        expectedVersion: saved.definition.version, expectedDraftRevision: saved.draft!.draftRevision,
      }, actor);
      nonResidentialPublished++;
    }
    const counts = {
      purposes: await db.collection('property_purpose_categories').countDocuments(),
      propertyTypes: await db.collection('property_types').countDocuments(),
      attributes: await db.collection('property_attributes').countDocuments(),
      amenities: await db.collection('amenities').countDocuments(),
      governorates: await db.collection('governorates').countDocuments(),
      cities: await db.collection('cities').countDocuments(),
      propertyOptions: await db.collection('property_options').countDocuments(),
      forms: await db.collection('property_form_definitions').countDocuments({ currentVersionId: { $exists: true } }),
    };
    if (Object.entries(counts).some(([key, count]) => count !== ({
      purposes: 4, propertyTypes: 19, attributes: 27, amenities: 12, governorates: 27, cities: DEFAULT_CITIES.length, propertyOptions: 12, forms: 19,
    } as Record<string, number>)[key])) throw new Error(`Rebuilt baseline count mismatch: ${JSON.stringify(counts)}`);
    console.log(JSON.stringify({ status: 'complete', counts, residentialVerified, nonResidentialPublished, alreadyMatching }));
  } finally {
    await app.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, '[REDACTED_URI]') : 'Phase 12 replay failed');
  process.exitCode = 1;
});
