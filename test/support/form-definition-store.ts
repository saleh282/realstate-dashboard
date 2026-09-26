import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import {
  CURRENT_RENDERER_VERSION,
  LEGACY_RESIDENTIAL_CONTENT,
  computeFormContentHash,
  computeLegacyWritable,
  type FieldDefinition,
  type MediaProfile,
} from '../../src/property-form-definitions/property-form-definition.constants';

/**
 * In-memory FormDefinition heads and versions for service-level property specs.
 * By default every property type a query asks about gets the seeded legacy v1
 * (what migration 026 creates for every existing type); `publish` adds a new
 * current version and supersedes the previous one; `archive` archives a head.
 */

type Head = { _id: Types.ObjectId; purposeSubcategoryId: Types.ObjectId; status: string; currentVersionId?: Types.ObjectId; currentVersion?: number; nextVersionNumber: number; version: number };
type Version = {
  _id: Types.ObjectId; definitionId: Types.ObjectId; purposeSubcategoryId: Types.ObjectId; version?: number; state: string;
  rendererVersion?: number; fields: FieldDefinition[]; mediaProfile: MediaProfile; amenitiesEnabled: boolean; legacyWritable?: boolean; contentHash?: string;
};
export type PublishInput = { fields: FieldDefinition[]; mediaProfile?: MediaProfile; amenitiesEnabled?: boolean; rendererVersion?: number };

const derivedId = (seed: string) => new Types.ObjectId(createHash('sha256').update(seed).digest('hex').slice(0, 24));
const key = (value: unknown) => String(value).toLowerCase();

export class FormDefinitionStore {
  readonly heads = new Map<string, Head>();
  readonly versions = new Map<string, Version>();
  readonly queries: Array<{ collection: 'definitions' | 'versions'; filter: any; session: boolean }> = [];

  constructor(private readonly options: { legacyForAnyType?: boolean } = {}) {}

  /** Head plus published legacy v1 for a type (idempotent). */
  seedLegacy(typeId: string): Version {
    const existing = this.heads.get(key(typeId));
    if (existing) return this.versions.get(key(existing.currentVersionId))!;
    const head: Head = { _id: derivedId(`head:${key(typeId)}`), purposeSubcategoryId: new Types.ObjectId(typeId), status: 'active', nextVersionNumber: 1, version: 0 };
    this.heads.set(key(typeId), head);
    return this.publish(typeId, { ...LEGACY_RESIDENTIAL_CONTENT, fields: LEGACY_RESIDENTIAL_CONTENT.fields.map((field) => ({ ...field })) });
  }

  /** A head with no published version (a type created after migration 026). */
  headWithoutVersion(typeId: string): Head {
    const head: Head = { _id: derivedId(`head:${key(typeId)}`), purposeSubcategoryId: new Types.ObjectId(typeId), status: 'active', nextVersionNumber: 1, version: 0 };
    this.heads.set(key(typeId), head);
    return head;
  }

  /** Publishes content as the type's new current version; the previous current is superseded. */
  publish(typeId: string, input: PublishInput): Version {
    const head = this.heads.get(key(typeId)) ?? this.headWithoutVersion(typeId);
    const content = {
      rendererVersion: input.rendererVersion ?? CURRENT_RENDERER_VERSION,
      fields: input.fields,
      mediaProfile: input.mediaProfile ?? 'residential_rooms',
      amenitiesEnabled: input.amenitiesEnabled ?? true,
    };
    if (head.currentVersionId) this.versions.get(key(head.currentVersionId))!.state = 'superseded';
    const number = head.nextVersionNumber;
    const version: Version = {
      _id: derivedId(`version:${key(typeId)}:${number}`), definitionId: head._id, purposeSubcategoryId: head.purposeSubcategoryId,
      version: number, state: 'published', ...content, legacyWritable: computeLegacyWritable(content), contentHash: computeFormContentHash(content),
    };
    this.versions.set(key(version._id), version);
    Object.assign(head, { currentVersionId: version._id, currentVersion: number, nextVersionNumber: number + 1, version: head.version + 1 });
    return version;
  }

  /** An unpublished draft version of a type's definition. */
  draft(typeId: string, input: PublishInput): Version {
    const head = this.heads.get(key(typeId)) ?? this.headWithoutVersion(typeId);
    const version: Version = {
      _id: derivedId(`draft:${key(typeId)}:${this.versions.size}`), definitionId: head._id, purposeSubcategoryId: head.purposeSubcategoryId, state: 'draft',
      fields: input.fields, mediaProfile: input.mediaProfile ?? 'residential_rooms', amenitiesEnabled: input.amenitiesEnabled ?? true,
    };
    this.versions.set(key(version._id), version);
    return version;
  }

  archive(typeId: string) { this.heads.get(key(typeId))!.status = 'archived'; }

  current(typeId: string): Version {
    const head = this.heads.get(key(typeId));
    if (!head?.currentVersionId) throw new Error(`no current version for ${typeId}`);
    return this.versions.get(key(head.currentVersionId))!;
  }

  models() {
    const store = this;
    const chain = (collection: 'definitions' | 'versions', filter: any, compute: () => unknown[]) => {
      const entry = { collection, filter, session: false };
      store.queries.push(entry);
      const query: any = {
        session: () => { entry.session = true; return query; },
        lean: () => query, select: () => query, sort: () => query,
        // Copies, so a caller can never mutate the store (ObjectIds are shared; they are immutable).
        exec: async () => compute().map((doc: any) => ({ ...doc, ...(doc.fields ? { fields: doc.fields.map((field: any) => ({ ...field })) } : {}) })),
      };
      return query;
    };
    const ids = (condition: any): string[] => (condition?.$in ?? [condition]).map(key);
    return {
      formDefinitions: {
        find: (filter: any) => chain('definitions', filter, () => ids(filter.purposeSubcategoryId).flatMap((typeId) => {
          if (!store.heads.has(typeId) && store.options.legacyForAnyType !== false) store.seedLegacy(typeId);
          const head = store.heads.get(typeId);
          return head ? [head] : [];
        })),
      },
      formVersions: {
        find: (filter: any) => chain('versions', filter, () => ids(filter._id).map((versionId) => store.versions.get(versionId)).filter(Boolean) as unknown[]),
      },
    };
  }
}
