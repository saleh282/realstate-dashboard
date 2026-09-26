import mongoose, { Types } from 'mongoose';
import { approvedFacets } from '../src/properties/property-form-write';
import { PropertyRevisionSchema } from '../src/properties/schemas/property-revision.schema';
import { PropertySchema } from '../src/properties/schemas/property.schema';
import { IDS, PropertyWorld, VILLA_V2_FIELDS, dynamicPayload, legacyPayload } from './support/property-world';

/**
 * DPF-020/023 persistence through real Mongoose documents (offline: validation,
 * change tracking and BSON serialization run exactly as they would against a
 * server). Covers what the in-memory world fakes: the pinned draft replacement
 * sent by `save()`, the empty attribute map, and the facets object.
 */

const Revision = mongoose.models.PersistenceRevision ?? mongoose.model('PersistenceRevision', PropertyRevisionSchema);
const Property = mongoose.models.PersistenceProperty ?? mongoose.model('PersistenceProperty', PropertySchema);
const LEGACY_FLAT = { bedrooms: 3, livingRooms: 1, kitchens: 1, bathrooms: 2, floor: 2, totalFloors: 5, buildingYear: 2020, finishingStatusCode: 'fully_finished', deliveryStatusCode: 'immediate' };

const pinnedRevision = (attributes: Record<string, unknown>) => ({
  propertyId: new Types.ObjectId(), revisionNumber: 1, createdByActorId: new Types.ObjectId(), operationType: 'sale', title: 'عنوان العقار', description: 'وصف',
  governorateCode: 'cairo', city: 'القاهرة', district: 'التجمع', latitude: 30, longitude: 31, area: 100, totalPriceMinor: 100, coverImageIndex: 0,
  formDefinitionId: new Types.ObjectId(), formDefinitionVersionId: new Types.ObjectId(), formDefinitionVersion: 1, formContentHash: 'a'.repeat(64), attributes,
});

describe('pinned revision persistence (real Mongoose documents, no server)', () => {
  it('validates and serializes an empty attribute map (minimize: false keeps the pin invariant)', async () => {
    const doc = new Revision(pinnedRevision({}));
    await expect(doc.validate()).resolves.toBeUndefined();
    expect((doc as any).toBSON().attributes).toEqual({});
  });

  it('turns a legacy draft into a pinned one with exactly the $set/$unset the service replacement implies', async () => {
    const world = new PropertyWorld();
    const villa = world.forms.publish(IDS.villa, { fields: VILLA_V2_FIELDS });
    const created = await world.service.create(IDS.user, legacyPayload({ purposeSubcategoryId: IDS.villa }), {});
    const stored = world.revision(created.property.revisionId);
    for (const key of ['formDefinitionId', 'formDefinitionVersionId', 'formDefinitionVersion', 'formContentHash', 'attributes']) delete stored[key];
    Object.assign(stored, LEGACY_FLAT);

    // Serve the draft to the service as a real hydrated Mongoose document and capture what save() would send.
    let changes: any;
    const revisions = (world.service as any).revisions;
    const lean = revisions.findOne;
    revisions.findOne = (filter: any) => {
      const chain = lean(filter);
      const exec = chain.exec;
      chain.exec = async () => {
        const found = await exec();
        if (!found || typeof found.save !== 'function') return found;
        const document: any = Revision.hydrate(world.revision(found._id));
        document.save = async function save() { await this.validate(); changes = this.getChanges(); };
        return document;
      };
      return chain;
    };

    await world.service.createDraftRevision(IDS.user, created.property.id, dynamicPayload(villa, { ...LEGACY_FLAT_ATTRIBUTES, hasGarden: true }, { purposeSubcategoryId: IDS.villa, expectedRevisionVersion: 0 }), {});
    expect(changes).toBeDefined();
    expect(Object.keys(changes.$unset ?? {}).sort()).toEqual(Object.keys(LEGACY_FLAT).sort());
    expect(changes.$set).toMatchObject({
      formDefinitionVersionId: villa._id, formDefinitionVersion: 2, formContentHash: villa.contentHash,
      attributes: { ...LEGACY_FLAT_ATTRIBUTES, hasGarden: true },
    });
    expect(String(changes.$set.formDefinitionId)).toBe(String(villa.definitionId));
  });

  it('rejects a half-pinned or attribute-less pinned revision through the schema hook', async () => {
    const partial: any = pinnedRevision({ bedrooms: 3 });
    delete partial.formContentHash;
    await expect(new Revision(partial).validate()).rejects.toThrow('PROPERTY_REVISION_FORM_PIN_INVALID');
    const noAttributes: any = pinnedRevision({});
    delete noAttributes.attributes;
    await expect(new Revision(noAttributes).validate()).rejects.toThrow('PROPERTY_REVISION_FORM_PIN_INVALID');
  });
});

const LEGACY_FLAT_ATTRIBUTES = { bedrooms: 3, livingRooms: 1, kitchens: 1, bathrooms: 2, floor: 2, totalFloors: 5, buildingYear: 2020, finishingStatus: 'fully_finished', deliveryStatus: 'immediate' };

describe('Property.facets persistence', () => {
  const property = (facets: unknown) => new Property({
    ownerId: new Types.ObjectId(), title: 'عنوان', description: 'وصف', governorateCode: 'cairo', city: 'القاهرة', district: 'التجمع',
    latitude: 30, longitude: 31, area: 100, operationType: 'sale', propertyTypeCode: 'apartment', images: [], coverImageIndex: 0, totalPriceMinor: 100, propertyContractVersion: 1,
    ...(facets === undefined ? {} : { facets }),
  });

  it('accepts exactly what approval derives and serializes no facets when none apply', async () => {
    const withBedrooms = property(approvedFacets({ bedrooms: 4, livingRooms: 2, hasGarden: true }));
    await expect(withBedrooms.validate()).resolves.toBeUndefined();
    expect((withBedrooms as any).toBSON().facets).toEqual({ bedrooms: 4 });
    expect(approvedFacets({ plotShape: 'regular' })).toEqual({});
    expect((property(undefined) as any).toBSON()).not.toHaveProperty('facets');
  });

  it('never produces a facet the typed schema would reject', async () => {
    for (const attributes of [{ bedrooms: 0 }, { bedrooms: 100 }, { bedrooms: 101 }, { bedrooms: -1 }, { bedrooms: 2.5 }, { bedrooms: '3' }, { bedrooms: null }]) {
      const facets = approvedFacets(attributes as Record<string, unknown>);
      await expect(property(facets).validate()).resolves.toBeUndefined();
    }
    expect(approvedFacets({ bedrooms: 0 })).toEqual({ bedrooms: 0 });
    expect(approvedFacets({ bedrooms: 101 })).toEqual({});
    expect(approvedFacets({ bedrooms: '3' })).toEqual({});
    await expect(property({ bedrooms: 3, bathrooms: 2 }).validate()).rejects.toThrow();
  });
});
