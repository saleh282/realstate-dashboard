'use strict';

const { createHash } = require('node:crypto');
const { Types } = require('mongoose');
const {
  CURRENT_RENDERER_VERSION,
  LEGACY_RESIDENTIAL_CONTENT,
  computeFormContentHash,
  computeLegacyWritable,
} = require('../../src/domain/property-form-definitions/property-form-definition.constants');
const derivedId = (seed) =>
  new Types.ObjectId(createHash('sha256').update(seed).digest('hex').slice(0, 24));
const key = (value) => String(value).toLowerCase();
class FormDefinitionStore {
  constructor(options = {}) {
    this.options = options;
    this.heads = new Map();
    this.versions = new Map();
    this.queries = [];
  }
  /** Head plus published legacy v1 for a type (idempotent). */
  seedLegacy(typeId) {
    const existing = this.heads.get(key(typeId));
    if (existing) return this.versions.get(key(existing.currentVersionId));
    const head = {
      _id: derivedId(`head:${key(typeId)}`),
      purposeSubcategoryId: new Types.ObjectId(typeId),
      status: 'active',
      nextVersionNumber: 1,
      version: 0,
    };
    this.heads.set(key(typeId), head);
    return this.publish(typeId, {
      ...LEGACY_RESIDENTIAL_CONTENT,
      fields: LEGACY_RESIDENTIAL_CONTENT.fields.map((field) => ({ ...field })),
    });
  }
  /** A head with no published version (a type created after migration 026). */
  headWithoutVersion(typeId) {
    const head = {
      _id: derivedId(`head:${key(typeId)}`),
      purposeSubcategoryId: new Types.ObjectId(typeId),
      status: 'active',
      nextVersionNumber: 1,
      version: 0,
    };
    this.heads.set(key(typeId), head);
    return head;
  }
  /** Publishes content as the type's new current version; the previous current is superseded. */
  publish(typeId, input) {
    const head = this.heads.get(key(typeId)) ?? this.headWithoutVersion(typeId);
    const content = {
      rendererVersion: input.rendererVersion ?? CURRENT_RENDERER_VERSION,
      fields: input.fields,
      mediaProfile: input.mediaProfile ?? 'residential_rooms',
      amenitiesEnabled: input.amenitiesEnabled ?? true,
      ...(input.allowedAmenityCodes !== undefined
        ? { allowedAmenityCodes: input.allowedAmenityCodes }
        : {}),
    };
    if (head.currentVersionId) this.versions.get(key(head.currentVersionId)).state = 'superseded';
    const number = head.nextVersionNumber;
    const version = {
      _id: derivedId(`version:${key(typeId)}:${number}`),
      definitionId: head._id,
      purposeSubcategoryId: head.purposeSubcategoryId,
      version: number,
      state: 'published',
      ...content,
      legacyWritable: computeLegacyWritable(content),
      contentHash: computeFormContentHash(content),
    };
    this.versions.set(key(version._id), version);
    Object.assign(head, {
      currentVersionId: version._id,
      currentVersion: number,
      nextVersionNumber: number + 1,
      version: head.version + 1,
    });
    return version;
  }
  /** An unpublished draft version of a type's definition. */
  draft(typeId, input) {
    const head = this.heads.get(key(typeId)) ?? this.headWithoutVersion(typeId);
    const version = {
      _id: derivedId(`draft:${key(typeId)}:${this.versions.size}`),
      definitionId: head._id,
      purposeSubcategoryId: head.purposeSubcategoryId,
      state: 'draft',
      fields: input.fields,
      mediaProfile: input.mediaProfile ?? 'residential_rooms',
      amenitiesEnabled: input.amenitiesEnabled ?? true,
      ...(input.allowedAmenityCodes !== undefined
        ? { allowedAmenityCodes: input.allowedAmenityCodes }
        : {}),
    };
    this.versions.set(key(version._id), version);
    return version;
  }
  archive(typeId) {
    this.heads.get(key(typeId)).status = 'archived';
  }
  current(typeId) {
    const head = this.heads.get(key(typeId));
    if (!head?.currentVersionId) throw new Error(`no current version for ${typeId}`);
    return this.versions.get(key(head.currentVersionId));
  }
  models() {
    const store = this;
    const chain = (collection, filter, compute) => {
      const entry = { collection, filter, session: false };
      store.queries.push(entry);
      const query = {
        session: () => {
          entry.session = true;
          return query;
        },
        lean: () => query,
        select: () => query,
        sort: () => query,
        // Copies, so a caller can never mutate the store (ObjectIds are shared; they are immutable).
        exec: async () =>
          compute().map((doc) => ({
            ...doc,
            ...(doc.fields ? { fields: doc.fields.map((field) => ({ ...field })) } : {}),
          })),
      };
      return query;
    };
    const ids = (condition) => (condition?.$in ?? [condition]).map(key);
    return {
      formDefinitions: {
        find: (filter) =>
          chain('definitions', filter, () =>
            ids(filter.purposeSubcategoryId).flatMap((typeId) => {
              if (!store.heads.has(typeId) && store.options.legacyForAnyType !== false)
                store.seedLegacy(typeId);
              const head = store.heads.get(typeId);
              return head ? [head] : [];
            }),
          ),
      },
      formVersions: {
        find: (filter) =>
          chain('versions', filter, () =>
            ids(filter._id)
              .map((versionId) => store.versions.get(versionId))
              .filter(Boolean),
          ),
      },
    };
  }
}

Object.assign(exports, { FormDefinitionStore });
