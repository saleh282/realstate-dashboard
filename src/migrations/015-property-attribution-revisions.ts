import { ObjectId, type Db, type Document } from 'mongodb';
import { EGP_CURRENCY, propertyMoneyFromStoredRecord } from '../common/money/money';
import { AccountType, resolveAccountType, resolveSystemRole } from '../users/identity.types';
import { SystemRole } from '../auth/roles.enum';

export type LegacyPropertyMigrationPlan = {
  propertySet: Record<string, unknown>;
  revision: Record<string, unknown>;
  warnings: string[];
};

export function legacyRevisionPointer(status: unknown, revisionId: ObjectId) {
  return status === 'approved'
    ? { currentPublicRevisionId: revisionId }
    : { pendingRevisionId: revisionId };
}

function objectId(value: unknown): ObjectId | undefined {
  if (value instanceof ObjectId) return value;
  if (typeof value === 'string' && ObjectId.isValid(value)) return new ObjectId(value);
  return undefined;
}

export function planLegacyPropertyRevision(
  property: Document,
  advertiser: Document,
  propertyType?: Document,
  paymentMethodExists = false,
): LegacyPropertyMigrationPlan {
  const propertyId = objectId(property._id);
  const advertiserId = objectId(property.ownerId);
  if (!propertyId || !advertiserId) throw new RangeError('Legacy property or owner identifier is invalid');
  if (resolveSystemRole(advertiser as any) !== SystemRole.USER) throw new RangeError('Legacy property advertiser is an administrative account');
  const accountType = resolveAccountType(advertiser as any);
  const money = propertyMoneyFromStoredRecord(property);
  const purposeSubcategoryId = objectId(propertyType?._id);
  const purposeCategoryId = objectId(propertyType?.purposeCategoryId);
  const paymentMethodCodes = paymentMethodExists && typeof property.paymentMethodCode === 'string'
    ? [property.paymentMethodCode]
    : undefined;
  const warnings = [
    ...(!purposeCategoryId ? ['PURPOSE_CATEGORY_UNKNOWN'] : []),
    ...(!purposeSubcategoryId ? ['PURPOSE_SUBCATEGORY_UNKNOWN'] : []),
    ...(!paymentMethodCodes ? ['PAYMENT_METHOD_UNKNOWN'] : []),
    'ENTRANCE_IMAGE_UNKNOWN',
    'MARKETING_MODE_UNKNOWN',
  ];
  const revision = {
    propertyId,
    revisionNumber: 1,
    createdByActorId: advertiserId,
    operationType: property.operationType,
    purposeCategoryId: purposeCategoryId ?? null,
    purposeSubcategoryId: purposeSubcategoryId ?? null,
    legacyPropertyTypeCode: property.propertyTypeCode,
    title: property.title,
    description: property.description,
    governorateCode: property.governorateCode,
    city: property.city,
    district: property.district,
    street: property.street,
    additionalAddressDetails: property.additionalAddressDetails,
    latitude: property.latitude,
    longitude: property.longitude,
    area: property.area,
    bedrooms: property.bedrooms,
    livingRooms: property.livingRooms,
    kitchens: property.kitchens,
    bathrooms: property.bathrooms,
    floor: property.floor,
    totalFloors: property.totalFloors,
    buildingYear: property.buildingYear,
    finishingStatusCode: property.finishingStatusCode,
    deliveryStatusCode: property.deliveryStatusCode,
    amenityCodes: property.amenityCodes ?? [],
    totalPriceMinor: money.totalPriceMinor,
    currency: EGP_CURRENCY,
    legacyDownPaymentMinor: money.downPaymentMinor,
    isPriceNegotiable: property.isPriceNegotiable ?? false,
    paymentMethodCodes,
    marketingMode: null,
    entranceImageAsset: null,
    galleryMedia: property.images ?? [],
    privateEvidenceAssets: property.titleDeed ? [property.titleDeed] : [],
    coverImageIndex: property.coverImageIndex ?? 0,
    hidePhone: property.hidePhone ?? false,
    moderationStatus: property.status ?? 'pending_review',
    submittedAt: property.createdAt,
    reviewReason: property.reviewReason,
    reviewedBy: property.reviewedBy,
    reviewedAt: property.reviewedAt,
  };
  return {
    propertySet: {
      advertiserAccountId: advertiserId,
      advertiserAccountTypeSnapshot: accountType as AccountType,
      createdByActorId: advertiserId,
      revisionSequence: 1,
      propertyContractVersion: 1,
    },
    revision,
    warnings,
  };
}

export async function scanLegacyPropertyRevisionMigration(db: Db) {
  const properties = db.collection('properties');
  const invalid: Array<{ id: string; reason: string }> = [];
  let invalidCount = 0;
  const warnings: Record<string, number> = {};
  let eligible = 0;
  let alreadyMigrated = 0;
  const cursor = properties.find({}, { projection: {
    ownerId: 1, propertyContractVersion: 1, operationType: 1, propertyTypeCode: 1,
    title: 1, description: 1, governorateCode: 1, city: 1, district: 1,
    street: 1, additionalAddressDetails: 1, latitude: 1, longitude: 1, area: 1,
    bedrooms: 1, livingRooms: 1, kitchens: 1, bathrooms: 1, floor: 1,
    totalFloors: 1, buildingYear: 1, finishingStatusCode: 1, deliveryStatusCode: 1,
    amenityCodes: 1, totalPriceMinor: 1, downPaymentMinor: 1, currency: 1,
    totalPrice: 1, downPayment: 1, paymentMethodCode: 1, images: 1, titleDeed: 1,
    coverImageIndex: 1, status: 1, createdAt: 1, reviewedAt: 1, reviewedBy: 1,
    reviewReason: 1, isPriceNegotiable: 1, hidePhone: 1,
  } });
  for await (const property of cursor) {
    if (property.propertyContractVersion >= 1) {
      alreadyMigrated += 1;
      continue;
    }
    try {
      const ownerId = objectId(property.ownerId);
      if (!ownerId) throw new RangeError('missing ownerId');
      const advertiser = await db.collection('users').findOne({ _id: ownerId });
      if (!advertiser) throw new RangeError('owner account does not exist');
      const propertyType = typeof property.propertyTypeCode === 'string'
        ? await db.collection('property_types').findOne({ code: property.propertyTypeCode })
        : undefined;
      const paymentExists = typeof property.paymentMethodCode === 'string'
        ? Boolean(await db.collection('property_options').findOne({ group: 'payment_method', code: property.paymentMethodCode }))
        : false;
      const plan = planLegacyPropertyRevision(property, advertiser, propertyType ?? undefined, paymentExists);
      for (const warning of plan.warnings) warnings[warning] = (warnings[warning] ?? 0) + 1;
      eligible += 1;
    } catch (error) {
      invalidCount += 1;
      if (invalid.length < 100) invalid.push({ id: property._id.toString(), reason: error instanceof Error ? error.message : 'unknown migration error' });
    }
  }
  return {
    eligible,
    alreadyMigrated,
    invalid,
    invalidCount,
    warnings,
  };
}
