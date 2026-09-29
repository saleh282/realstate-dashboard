import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { LruCache } from '../common/cache/lru-cache';
import { mediaRequirements, type MediaRequirements } from '../properties/media-profiles';
import {
  FormDefinitionErrorCode,
  PROPERTY_FORM_LIMITS,
  READABLE_FORM_VERSION_STATES,
  type FieldDefinition,
  type MediaProfile,
} from './property-form-definition.constants';
import { PropertyFormDefinition, type PropertyFormDefinitionDocument } from './schemas/property-form-definition.schema';
import { PropertyFormDefinitionVersion, type PropertyFormDefinitionVersionDocument } from './schemas/property-form-definition-version.schema';

/** Frozen §D #3 response. Contains nothing that can change after publish. */
export type PublicFormVersion = {
  versionId: string;
  definitionId: string;
  purposeSubcategoryId: string;
  version: number;
  rendererVersion: number;
  contentHash: string;
  amenitiesEnabled: boolean;
  /** Phase 11 type-aware amenities: absent means the legacy full-active-catalog-when-enabled behavior. */
  allowedAmenityCodes?: string[];
  fields: FieldDefinition[];
  mediaRequirements: MediaRequirements;
};

/** A property type's current published form, as advertised to clients. */
export type FormDefinitionPointer = {
  purposeSubcategoryId: string;
  definitionId: string;
  currentVersionId: string;
  currentVersion: number;
  contentHash: string;
  rendererVersion: number;
  legacyWritable: boolean;
};

const FIELD_PROPERTIES: readonly (keyof FieldDefinition)[] = [
  'key', 'dataType', 'unit', 'optionSource', 'catalogGroup', 'labelAr', 'labelEn', 'helpAr', 'helpEn', 'placeholderAr',
  'required', 'order', 'operations', 'validation', 'options', 'widget',
];

@Injectable()
export class PropertyFormDefinitionsService {
  /** Published/superseded versions never change, so a read can be cached for the process lifetime. */
  private readonly versionCache = new LruCache<string, PublicFormVersion>(PROPERTY_FORM_LIMITS.versionCacheSize);

  constructor(
    @InjectModel(PropertyFormDefinition.name) private readonly definitions: Model<PropertyFormDefinitionDocument>,
    @InjectModel(PropertyFormDefinitionVersion.name) private readonly versions: Model<PropertyFormDefinitionVersionDocument>,
  ) {}

  /**
   * Frozen §D #3: only published or superseded versions are readable. Drafts,
   * unknown ids and malformed ids are the same 404 (nothing to enumerate).
   */
  async getPublicVersion(versionId: string): Promise<PublicFormVersion> {
    const notFound = () => new NotFoundException({ message: 'نسخة نموذج العقار غير موجودة', code: FormDefinitionErrorCode.NOT_FOUND });
    if (!/^[a-fA-F0-9]{24}$/.test(versionId)) throw notFound();
    const key = versionId.toLowerCase();
    const cached = this.versionCache.get(key);
    if (cached) return cached;
    const version = await this.versions.findOne({ _id: new Types.ObjectId(key), state: { $in: [...READABLE_FORM_VERSION_STATES] } }).lean().exec();
    if (!version) throw notFound();
    const projection = toPublicVersion(version);
    this.versionCache.set(key, projection);
    return projection;
  }

  /**
   * Current published form per property type, for active (not archived)
   * definitions only. A head whose current version is missing or not
   * published yields no pointer (the type is not creatable).
   */
  async creationPointers(): Promise<Map<string, FormDefinitionPointer>> {
    const heads = await this.definitions.find({ status: 'active', currentVersionId: { $exists: true, $ne: null } }).lean().exec();
    if (!heads.length) return new Map();
    const versions = await this.versions
      .find({ _id: { $in: heads.map((head) => head.currentVersionId) }, state: 'published' }, { contentHash: 1, rendererVersion: 1, legacyWritable: 1, version: 1, definitionId: 1 })
      .lean()
      .exec();
    const versionById = new Map(versions.map((version) => [String(version._id), version]));
    const pointers = new Map<string, FormDefinitionPointer>();
    for (const head of heads) {
      const version = versionById.get(String(head.currentVersionId));
      if (!version || String(version.definitionId) !== String(head._id)) continue;
      pointers.set(String(head.purposeSubcategoryId), {
        purposeSubcategoryId: String(head.purposeSubcategoryId),
        definitionId: String(head._id),
        currentVersionId: String(version._id),
        currentVersion: version.version!,
        contentHash: version.contentHash!,
        rendererVersion: version.rendererVersion!,
        legacyWritable: version.legacyWritable === true,
      });
    }
    return pointers;
  }
}

export function toPublicVersion(version: any): PublicFormVersion {
  return {
    versionId: String(version._id),
    definitionId: String(version.definitionId),
    purposeSubcategoryId: String(version.purposeSubcategoryId),
    version: version.version,
    rendererVersion: version.rendererVersion,
    contentHash: version.contentHash,
    amenitiesEnabled: version.amenitiesEnabled,
    ...(version.allowedAmenityCodes !== undefined ? { allowedAmenityCodes: version.allowedAmenityCodes } : {}),
    fields: [...(version.fields ?? [])]
      .sort((a: FieldDefinition, b: FieldDefinition) => a.order - b.order)
      .map((field: FieldDefinition) => Object.fromEntries(FIELD_PROPERTIES.filter((property) => field[property] !== undefined && field[property] !== null).map((property) => [property, field[property]])) as FieldDefinition),
    mediaRequirements: mediaRequirements(version.mediaProfile as MediaProfile),
  };
}
