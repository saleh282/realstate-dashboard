import { Logger } from '@nestjs/common';
import { emitOperationalEvent } from '../common/observability/operational-metrics';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { TransactionAttemptConflict, retryConflict, runTransactionWithRetry } from '../common/mongo/transaction-runner';
import { mediaRequirements } from '../properties/media-profiles';
import { PROPERTY_ATTRIBUTE_LIMITS } from '../property-attributes/property-attribute.constants';
import { PropertyAttribute, type PropertyAttributeDocument } from '../property-attributes/schemas/property-attribute.schema';
import { PropertyType, type PropertyTypeDocument } from '../property-types/schemas/property-type.schema';
import { Amenity, type AmenityDocument } from '../amenities/schemas/amenity.schema';
import {
  buildDraftContent,
  canonicalContentHash,
  diffFormContent,
  publishableContent,
  storedContent,
  validateFormContent,
  type AmenityCatalogEntry,
  type FormDraftError,
  type RegistryAttribute,
} from './form-definition-drafts';
import type { ArchiveFormDefinitionDto, CreateFormDefinitionDto, DiscardFormDraftDto, ExpectedFormVersionDto, PublishFormDraftDto, UpdateFormDraftDto } from './dto/admin-form-definition.dto';
import {
  CURRENT_RENDERER_VERSION,
  FORM_OPERATION_TYPES,
  FORM_WIDGETS_BY_DATA_TYPE,
  FormDefinitionErrorCode,
  PROPERTY_FORM_LIMITS,
  SHIPPED_MEDIA_PROFILES,
  computeFormContentHash,
  computeLegacyWritable,
  type FieldDefinition,
  type FormVersionContent,
  type MediaProfile,
} from './property-form-definition.constants';
import { PropertyFormDefinition, type PropertyFormDefinitionDocument } from './schemas/property-form-definition.schema';
import { PropertyFormDefinitionVersion, type PropertyFormDefinitionVersionDocument } from './schemas/property-form-definition-version.schema';

export type FormAdminActor = { userId: string; ip?: string };

/** Unique indexes whose duplicate-key error means a lost race that a fresh attempt re-decides. */
const RACE_INDEXES = ['property_form_definition_subcategory_unique', 'property_form_version_one_draft', 'property_form_version_one_published'];
/** A new definition starts with an empty draft on the always-available profile; Admin adds fields and chooses the profile. */
const INITIAL_DRAFT = { fields: [] as FieldDefinition[], mediaProfile: 'generic' as MediaProfile, amenitiesEnabled: false };
const OBJECT_ID = /^[a-fA-F0-9]{24}$/;

/**
 * DPF-030..032: the Admin form-builder lifecycle. One draft per definition;
 * every mutation carries an optimistic-concurrency token (the head's
 * `version`, the draft's `draftRevision`) and runs in one snapshot
 * transaction with its audit record, so it either happens completely (state
 * and audit) or not at all. Published versions are never modified except
 * published -> superseded; nothing here deletes a head or a published version.
 */
@Injectable()
export class AdminPropertyFormDefinitionsService {
  private readonly opsLogger = new Logger('FormLifecycle');
  constructor(
    @InjectModel(PropertyFormDefinition.name) private readonly definitions: Model<PropertyFormDefinitionDocument>,
    @InjectModel(PropertyFormDefinitionVersion.name) private readonly versions: Model<PropertyFormDefinitionVersionDocument>,
    @InjectModel(PropertyAttribute.name) private readonly attributes: Model<PropertyAttributeDocument>,
    @InjectModel(PropertyType.name) private readonly types: Model<PropertyTypeDocument>,
    @InjectModel(Amenity.name) private readonly amenities: Model<AmenityDocument>,
    private readonly audit: AuditLogService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  // ------------------------------------------------------------ reads

  /** The Attribute Registry as Admin may use it (read-only: identity is engineering-owned). */
  async listAttributes() {
    const items = await this.attributes.find({}).sort({ key: 1 }).lean().exec();
    return { items: items.map((item) => attributeView(item)) };
  }

  /** The closed sets and limits a form builder offers. */
  builderOptions() {
    return {
      rendererVersion: CURRENT_RENDERER_VERSION,
      operationTypes: [...FORM_OPERATION_TYPES],
      widgetsByDataType: Object.fromEntries(Object.entries(FORM_WIDGETS_BY_DATA_TYPE).map(([dataType, widgets]) => [dataType, [...widgets]])),
      mediaProfiles: SHIPPED_MEDIA_PROFILES.map((profile) => mediaRequirements(profile)),
      limits: {
        maxFields: PROPERTY_FORM_LIMITS.maxFields,
        fieldOrderMin: PROPERTY_FORM_LIMITS.fieldOrderMin,
        fieldOrderMax: PROPERTY_FORM_LIMITS.fieldOrderMax,
        maxFieldBytes: PROPERTY_FORM_LIMITS.maxFieldBytes,
        maxVersionBytes: PROPERTY_FORM_LIMITS.maxVersionBytes,
        changeNoteMaxLength: PROPERTY_FORM_LIMITS.changeNoteMaxLength,
        archiveReasonMaxLength: PROPERTY_FORM_LIMITS.archiveReasonMaxLength,
        labelMaxLength: PROPERTY_ATTRIBUTE_LIMITS.labelMaxLength,
        helpMaxLength: PROPERTY_ATTRIBUTE_LIMITS.helpMaxLength,
        placeholderMaxLength: PROPERTY_ATTRIBUTE_LIMITS.placeholderMaxLength,
        optionsMin: PROPERTY_ATTRIBUTE_LIMITS.optionsMin,
        optionsMax: PROPERTY_ATTRIBUTE_LIMITS.optionsMax,
      },
    };
  }

  /**
   * Every property type with its definition state. A type with no head
   * (created after migration 026) is listed with `definition: null`, which
   * is how Admin finds types that still need a form.
   */
  async listDefinitions() {
    const [types, heads] = await Promise.all([
      this.types.find({}).sort({ sortOrder: 1, nameAr: 1 }).lean().exec(),
      this.definitions.find({}).lean().exec(),
    ]);
    const versionIds = heads.flatMap((head) => [head.currentVersionId, head.draftVersionId]).filter(Boolean);
    const versions = versionIds.length
      ? await this.versions.find({ _id: { $in: versionIds } }, { state: 1, version: 1, contentHash: 1, legacyWritable: 1, rendererVersion: 1, draftRevision: 1, definitionId: 1 }).lean().exec()
      : [];
    const versionById = new Map(versions.map((version) => [String(version._id), version]));
    const headByType = new Map(heads.map((head) => [String(head.purposeSubcategoryId), head]));
    const typeIds = new Set(types.map((type) => String(type._id)));
    const summary = (head: any) => {
      const current = head.currentVersionId ? versionById.get(String(head.currentVersionId)) : undefined;
      const draft = head.draftVersionId ? versionById.get(String(head.draftVersionId)) : undefined;
      return {
        ...headView(head),
        currentContentHash: current?.contentHash ?? null,
        currentLegacyWritable: current ? current.legacyWritable === true : null,
        currentRendererVersion: current?.rendererVersion ?? null,
        draftRevision: draft?.draftRevision ?? null,
      };
    };
    const items = types.map((type) => {
      const head = headByType.get(String(type._id));
      return { purposeSubcategoryId: String(type._id), type: typeView(type), definition: head ? summary(head) : null };
    });
    // A head whose type no longer exists stays visible (history is never hidden).
    const orphans = heads
      .filter((head) => !typeIds.has(String(head.purposeSubcategoryId)))
      .sort((a, b) => String(a._id).localeCompare(String(b._id)))
      .map((head) => ({ purposeSubcategoryId: String(head.purposeSubcategoryId), type: null, definition: summary(head) }));
    return { items: [...items, ...orphans] };
  }

  /** Head, current and draft content, and the full version history (newest first). */
  async getDefinition(definitionId: string) {
    const head = await this.definitions.findById(this.objectId(definitionId)).lean().exec();
    if (!head) throw notFound();
    const [type, versions] = await Promise.all([
      this.types.findById(head.purposeSubcategoryId).lean().exec(),
      this.versions.find({ definitionId: head._id }).lean().exec(),
    ]);
    const current = versions.find((version) => String(version._id) === String(head.currentVersionId)) ?? null;
    const draft = versions.find((version) => String(version._id) === String(head.draftVersionId) && version.state === 'draft') ?? null;
    const history = versions
      .filter((version) => version.state !== 'draft')
      .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))
      .map((version) => versionSummary(version));
    return {
      definition: headView(head),
      type: type ? typeView(type) : null,
      current: current ? versionView(current) : null,
      draft: draft ? versionView(draft) : null,
      history,
    };
  }

  /** Any version of this definition, drafts included (Admin only; the public read never serves drafts). */
  async getVersion(definitionId: string, versionId: string) {
    const version = await this.versions.findOne({ _id: this.objectId(versionId), definitionId: this.objectId(definitionId) }).lean().exec();
    if (!version) throw notFound();
    return { version: versionView(version) };
  }

  /** Full publish validation of the stored draft (an empty draft is reported as unpublishable), without changing it. */
  async validateDraft(definitionId: string) {
    const { head, draft } = await this.loadDraft(definitionId);
    const content = publishableContent(draft);
    const errors = await this.validationErrors(content, draft);
    return {
      definitionId: String(head._id),
      draftVersionId: String(draft._id),
      draftRevision: draft.draftRevision,
      valid: errors.length === 0,
      errors,
      contentHash: computeFormContentHash(content),
      legacyWritable: computeLegacyWritable(content),
    };
  }

  /** Deterministic diff of the draft against the current published version. */
  async diffDraft(definitionId: string) {
    const { head, draft } = await this.loadDraft(definitionId);
    const current = head.currentVersionId ? await this.versions.findOne({ _id: head.currentVersionId, definitionId: head._id }).lean().exec() : null;
    const base = current ? storedContent(current as any) : null;
    const next = publishableContent(draft);
    return {
      definitionId: String(head._id),
      draftVersionId: String(draft._id),
      draftRevision: draft.draftRevision,
      base: current ? { versionId: String(current._id), version: current.version ?? null, contentHash: current.contentHash ?? null } : null,
      draftContentHash: computeFormContentHash(next),
      ...diffFormContent(base, next),
    };
  }

  // ------------------------------------------------------------ mutations

  /**
   * Creates the head for a property type that has none (a type created after
   * migration 026) together with an empty draft. Nothing is published: the
   * type stays hidden from every client until a valid version is published.
   */
  async createDefinition(dto: CreateFormDefinitionDto, actor: FormAdminActor) {
    const typeId = this.objectId(dto.purposeSubcategoryId, () => typeNotEligible('TYPE_NOT_FOUND'));
    const result = await this.transaction(async (session) => {
      const type = await this.types.findById(typeId).session(session).lean().exec();
      if (!type) throw typeNotEligible('TYPE_NOT_FOUND');
      if (!type.purposeCategoryId) throw typeNotEligible('TYPE_NOT_MAPPED');
      const existing = await this.definitions.findOne({ purposeSubcategoryId: typeId }).session(session).lean().exec();
      if (existing) throw new ConflictException({ message: 'يوجد نموذج لهذا النوع بالفعل', code: FormDefinitionErrorCode.EXISTS, details: { definitionId: String(existing._id) } });
      const definitionId = new Types.ObjectId();
      const draftId = new Types.ObjectId();
      const actorId = new Types.ObjectId(actor.userId);
      await this.versions.create([{ _id: draftId, definitionId, purposeSubcategoryId: typeId, state: 'draft', ...INITIAL_DRAFT, draftRevision: 0 }], { session });
      const [head] = await this.definitions.create([{ _id: definitionId, purposeSubcategoryId: typeId, status: 'active', draftVersionId: draftId, nextVersionNumber: 1, version: 0, createdBy: actorId, updatedBy: actorId }], { session });
      await this.record(session, actor, AuditAction.ADMIN_FORM_DEFINITION_CREATED, definitionId, 'created property form definition', { definitionId: String(definitionId), purposeSubcategoryId: String(typeId) });
      await this.record(session, actor, AuditAction.ADMIN_FORM_DRAFT_CREATED, definitionId, 'created property form draft', { definitionId: String(definitionId), draftVersionId: String(draftId), basedOnVersionId: null, basedOnVersion: null });
      return head.toObject();
    });
    return { message: 'تم إنشاء نموذج نوع العقار ومسودته الأولى', ...(await this.getDefinition(String(result._id))) };
  }

  /** Opens the one draft of a definition, copied from its current published version. */
  async createDraft(definitionId: string, dto: ExpectedFormVersionDto, actor: FormAdminActor) {
    const id = this.objectId(definitionId);
    await this.transaction(async (session) => {
      const head = await this.head(id, session);
      assertHeadVersion(head, dto.expectedVersion);
      if (head.draftVersionId) throw new ConflictException({ message: 'توجد مسودة مفتوحة لهذا النموذج بالفعل', code: FormDefinitionErrorCode.DRAFT_EXISTS, details: { draftVersionId: String(head.draftVersionId) } });
      const current = head.currentVersionId ? await this.versions.findOne({ _id: head.currentVersionId, definitionId: head._id, state: 'published' }).session(session).lean().exec() : null;
      if (head.currentVersionId && !current) throw currentVersionInvalid();
      const draftId = new Types.ObjectId();
      const content = current
        ? {
            fields: current.fields.map((field) => ({ ...field })), mediaProfile: current.mediaProfile as MediaProfile, amenitiesEnabled: current.amenitiesEnabled,
            ...(current.allowedAmenityCodes !== undefined ? { allowedAmenityCodes: [...current.allowedAmenityCodes] } : {}),
          }
        : INITIAL_DRAFT;
      await this.versions.create([{
        _id: draftId, definitionId: head._id, purposeSubcategoryId: head.purposeSubcategoryId, state: 'draft', ...content, draftRevision: 0,
        ...(current ? { basedOnVersionId: current._id } : {}),
      }], { session });
      await this.advanceHead(session, head, dto.expectedVersion, { $set: { draftVersionId: draftId, updatedBy: new Types.ObjectId(actor.userId) } }, { draftVersionId: null });
      await this.record(session, actor, AuditAction.ADMIN_FORM_DRAFT_CREATED, head._id, 'created property form draft', {
        definitionId: String(head._id), draftVersionId: String(draftId), basedOnVersionId: current ? String(current._id) : null, basedOnVersion: current?.version ?? null,
      });
    });
    return { message: 'تم فتح مسودة جديدة للنموذج', ...(await this.getDefinition(definitionId)) };
  }

  /**
   * Replaces the draft's content. The request carries only frozen editable
   * properties; identity is copied from the registry, and content that could
   * not be published is refused with every structured error (nothing saved).
   */
  async updateDraft(definitionId: string, dto: UpdateFormDraftDto, actor: FormAdminActor) {
    const id = this.objectId(definitionId);
    await this.transaction(async (session) => {
      const { head, draft } = await this.loadDraft(id, session);
      assertDraftRevision(draft, dto.expectedDraftRevision);
      const registry = await this.registry(dto.fields.map((field) => field.key), session);
      const built = buildDraftContent(dto, registry);
      const content: FormVersionContent = { rendererVersion: CURRENT_RENDERER_VERSION, ...built };
      const base = await this.baseVersion(draft, session);
      const errors = validateFormContent(content, registry, {
        stage: 'draft',
        baseFields: base?.fields ?? [],
        amenityCatalog: await this.amenityCatalogFor(content.allowedAmenityCodes, session),
        baseAllowedAmenityCodes: base?.allowedAmenityCodes ?? [],
      });
      if (errors.length) throw draftInvalid(FormDefinitionErrorCode.DRAFT_INVALID, errors);
      const changeNote = dto.changeNote?.trim();
      const unset: Record<string, 1> = {};
      if (!changeNote) unset.changeNote = 1;
      if (built.allowedAmenityCodes === undefined) unset.allowedAmenityCodes = 1;
      const updated = await this.versions.findOneAndUpdate(
        { _id: draft._id, definitionId: head._id, state: 'draft', draftRevision: dto.expectedDraftRevision },
        {
          $set: { fields: built.fields, mediaProfile: built.mediaProfile, amenitiesEnabled: built.amenitiesEnabled, ...(changeNote ? { changeNote } : {}), ...(built.allowedAmenityCodes !== undefined ? { allowedAmenityCodes: built.allowedAmenityCodes } : {}) },
          ...(Object.keys(unset).length ? { $unset: unset } : {}),
          $inc: { draftRevision: 1 },
        },
        { new: true, session, runValidators: true },
      ).lean().exec();
      if (!updated) throw new TransactionAttemptConflict();
      await this.record(session, actor, AuditAction.ADMIN_FORM_DRAFT_UPDATED, head._id, 'updated property form draft', {
        definitionId: String(head._id), draftVersionId: String(draft._id), draftRevision: updated.draftRevision, fieldCount: built.fields.length, contentHash: computeFormContentHash(content),
      });
    });
    return { message: 'تم حفظ مسودة النموذج', ...(await this.getDefinition(definitionId)) };
  }

  /** Throws the draft away (drafts are the only versions that can be removed). */
  async discardDraft(definitionId: string, dto: DiscardFormDraftDto, actor: FormAdminActor) {
    const id = this.objectId(definitionId);
    await this.transaction(async (session) => {
      const { head, draft } = await this.loadDraft(id, session);
      assertHeadVersion(head, dto.expectedVersion);
      assertDraftRevision(draft, dto.expectedDraftRevision);
      const removed = await this.versions.deleteOne({ _id: draft._id, definitionId: head._id, state: 'draft', draftRevision: dto.expectedDraftRevision }).session(session).exec();
      if (removed.deletedCount !== 1) throw new TransactionAttemptConflict();
      await this.advanceHead(session, head, dto.expectedVersion, { $unset: { draftVersionId: 1 }, $set: { updatedBy: new Types.ObjectId(actor.userId) } }, { draftVersionId: draft._id });
      await this.record(session, actor, AuditAction.ADMIN_FORM_DRAFT_DISCARDED, head._id, 'discarded property form draft', {
        definitionId: String(head._id), draftVersionId: String(draft._id), draftRevision: draft.draftRevision,
      });
    });
    return { message: 'تم حذف مسودة النموذج', ...(await this.getDefinition(definitionId)) };
  }

  /**
   * DPF-032 publish, in one transaction: re-read head and draft, check both
   * tokens, re-run full validation, canonicalize and hash, supersede the old
   * current version, turn the draft into the next immutable version, move
   * the head's pointers, and write the audit record. Any failure aborts all
   * of it: the old version stays current and the draft stays editable.
   */
  async publish(definitionId: string, dto: PublishFormDraftDto, actor: FormAdminActor) {
    const id = this.objectId(definitionId);
    const published = await this.transaction(async (session) => {
      const { head, draft } = await this.loadDraft(id, session);
      assertHeadVersion(head, dto.expectedVersion);
      assertDraftRevision(draft, dto.expectedDraftRevision);
      if (head.status !== 'active') throw archived();
      const content = publishableContent(draft);
      const errors = await this.validationErrors(content, draft, session);
      if (errors.length) throw draftInvalid(FormDefinitionErrorCode.PUBLISH_INVALID, errors);
      const contentHash = computeFormContentHash(content);
      const legacyWritable = computeLegacyWritable(content);

      const previous = head.currentVersionId ? await this.versions.findOne({ _id: head.currentVersionId, definitionId: head._id }).session(session).lean().exec() : null;
      if (head.currentVersionId && previous?.state !== 'published') throw currentVersionInvalid();
      if (previous && canonicalContentHash(storedContent(previous as any)) === contentHash) {
        throw new ConflictException({ message: 'لا توجد تغييرات عن النسخة المنشورة الحالية', code: FormDefinitionErrorCode.NO_CHANGES, details: { currentVersionId: String(previous._id) } });
      }
      const number = head.nextVersionNumber;
      const now = new Date();
      if (previous) {
        const superseded = await this.versions.updateOne({ _id: previous._id, state: 'published' }, { $set: { state: 'superseded', supersededAt: now } }).session(session).exec();
        if (superseded.matchedCount !== 1) throw new TransactionAttemptConflict();
      }
      const version = await this.versions.findOneAndUpdate(
        { _id: draft._id, definitionId: head._id, state: 'draft', draftRevision: dto.expectedDraftRevision },
        { $set: {
          state: 'published', version: number, fields: content.fields, mediaProfile: content.mediaProfile, amenitiesEnabled: content.amenitiesEnabled,
          rendererVersion: content.rendererVersion, legacyWritable, contentHash, publishedAt: now, publishedBy: new Types.ObjectId(actor.userId),
          ...(content.allowedAmenityCodes !== undefined ? { allowedAmenityCodes: content.allowedAmenityCodes } : {}),
        }, ...(content.allowedAmenityCodes === undefined ? { $unset: { allowedAmenityCodes: 1 } } : {}) },
        { new: true, session, runValidators: true },
      ).lean().exec();
      if (!version) throw new TransactionAttemptConflict();
      await this.advanceHead(session, head, dto.expectedVersion, {
        $set: { currentVersionId: version._id, currentVersion: number, updatedBy: new Types.ObjectId(actor.userId) },
        $unset: { draftVersionId: 1 },
        $inc: { nextVersionNumber: 1 },
      }, { draftVersionId: draft._id, status: 'active' });
      const diff = diffFormContent(previous ? storedContent(previous as any) : null, content);
      await this.record(session, actor, AuditAction.ADMIN_FORM_VERSION_PUBLISHED, head._id, `published property form version ${number}`, {
        definitionId: String(head._id), purposeSubcategoryId: String(head.purposeSubcategoryId), versionId: String(version._id), version: number, contentHash, legacyWritable,
        rendererVersion: content.rendererVersion, previousVersionId: previous ? String(previous._id) : null, previousVersion: previous?.version ?? null,
        fieldCount: content.fields.length, fieldsAdded: diff.fieldsAdded.length, fieldsRemoved: diff.fieldsRemoved.length, fieldsChanged: diff.fieldsChanged.length,
      });
      return version;
    });
    emitOperationalEvent(this.opsLogger, 'log', 'form_definition_published', { definitionId, version: (published as any).version, contentHash: (published as any).contentHash });
    return { message: 'تم نشر نسخة جديدة من النموذج', published: versionSummary(published), ...(await this.getDefinition(definitionId)) };
  }

  /** Stops new writes with this definition; history, versions and existing listings are untouched. */
  async archive(definitionId: string, dto: ArchiveFormDefinitionDto, actor: FormAdminActor) {
    const id = this.objectId(definitionId);
    const reason = dto.reason.trim();
    await this.transaction(async (session) => {
      const head = await this.head(id, session);
      assertHeadVersion(head, dto.expectedVersion);
      if (head.status !== 'active') throw archived();
      const actorId = new Types.ObjectId(actor.userId);
      await this.advanceHead(session, head, dto.expectedVersion, { $set: { status: 'archived', archivedAt: new Date(), archivedBy: actorId, archivedReason: reason, updatedBy: actorId } }, { status: 'active' });
      await this.record(session, actor, AuditAction.ADMIN_FORM_DEFINITION_ARCHIVED, head._id, reason, {
        definitionId: String(head._id), purposeSubcategoryId: String(head.purposeSubcategoryId), currentVersionId: head.currentVersionId ? String(head.currentVersionId) : null, currentVersion: head.currentVersion ?? null,
      });
    });
    emitOperationalEvent(this.opsLogger, 'warn', 'form_definition_archived', { definitionId });
    return { message: 'تم إيقاف نموذج نوع العقار', ...(await this.getDefinition(definitionId)) };
  }

  /** Re-enables an archived definition when its current published version (if any) is intact. */
  async restore(definitionId: string, dto: ExpectedFormVersionDto, actor: FormAdminActor) {
    const id = this.objectId(definitionId);
    await this.transaction(async (session) => {
      const head = await this.head(id, session);
      assertHeadVersion(head, dto.expectedVersion);
      if (head.status !== 'archived') throw new ConflictException({ message: 'النموذج غير موقوف', code: FormDefinitionErrorCode.NOT_ARCHIVED });
      if (head.currentVersionId) {
        const current = await this.versions.findOne({ _id: head.currentVersionId, definitionId: head._id }).session(session).lean().exec();
        // Same integrity rule property writes apply: the stored content still hashes to its recorded hash.
        const intact = current?.contentHash === computeFormContentHash({ rendererVersion: current?.rendererVersion as number, fields: current?.fields ?? [], mediaProfile: current?.mediaProfile as MediaProfile, amenitiesEnabled: current?.amenitiesEnabled as boolean, allowedAmenityCodes: current?.allowedAmenityCodes });
        if (!current || current.state !== 'published' || !intact) throw currentVersionInvalid();
      }
      await this.advanceHead(session, head, dto.expectedVersion, {
        $set: { status: 'active', updatedBy: new Types.ObjectId(actor.userId) },
        $unset: { archivedAt: 1, archivedBy: 1, archivedReason: 1 },
      }, { status: 'archived' });
      await this.record(session, actor, AuditAction.ADMIN_FORM_DEFINITION_RESTORED, head._id, 'restored property form definition', {
        definitionId: String(head._id), purposeSubcategoryId: String(head.purposeSubcategoryId), currentVersionId: head.currentVersionId ? String(head.currentVersionId) : null, currentVersion: head.currentVersion ?? null,
      });
    });
    emitOperationalEvent(this.opsLogger, 'log', 'form_definition_restored', { definitionId });
    return { message: 'تمت إعادة تفعيل نموذج نوع العقار', ...(await this.getDefinition(definitionId)) };
  }

  // ------------------------------------------------------------ internals

  private transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    return runTransactionWithRetry(this.connection, work, {
      uniqueIndexNames: RACE_INDEXES,
      retryExhausted: retryConflict('تم تعديل النموذج بواسطة طلب آخر؛ أعد تحميل البيانات', FormDefinitionErrorCode.VERSION_CONFLICT),
    });
  }

  private objectId(value: string, error: () => Error = notFound): Types.ObjectId {
    if (typeof value !== 'string' || !OBJECT_ID.test(value)) throw error();
    return new Types.ObjectId(value.toLowerCase());
  }

  private async head(id: Types.ObjectId, session?: ClientSession) {
    const query = this.definitions.findById(id);
    if (session) query.session(session);
    const head = await query.lean().exec();
    if (!head) throw notFound();
    return head;
  }

  private async loadDraft(definitionId: string | Types.ObjectId, session?: ClientSession) {
    const head = await this.head(typeof definitionId === 'string' ? this.objectId(definitionId) : definitionId, session);
    if (!head.draftVersionId) throw draftNotFound();
    const query = this.versions.findOne({ _id: head.draftVersionId, definitionId: head._id });
    if (session) query.session(session);
    const draft = await query.lean().exec();
    if (!draft) throw draftNotFound();
    if (draft.state !== 'draft') throw new ConflictException({ message: 'هذه النسخة منشورة ولا يمكن تعديلها', code: FormDefinitionErrorCode.NOT_DRAFT });
    return { head, draft };
  }

  /**
   * Moves the head forward under its concurrency token. The filter repeats
   * what the caller checked; a miss means another transaction won, which the
   * runner turns into a fresh attempt (which then reports the conflict).
   */
  private async advanceHead(session: ClientSession, head: { _id: Types.ObjectId }, expectedVersion: number, update: Record<string, any>, guard: Record<string, unknown>) {
    const moved = await this.definitions.findOneAndUpdate(
      { _id: head._id, version: expectedVersion, ...guard },
      { ...update, $inc: { ...(update.$inc ?? {}), version: 1 } },
      { new: true, session, runValidators: true },
    ).lean().exec();
    if (!moved) throw new TransactionAttemptConflict();
    return moved;
  }

  private async registry(keys: readonly string[], session?: ClientSession): Promise<Map<string, RegistryAttribute>> {
    const unique = [...new Set(keys.filter((key) => typeof key === 'string'))];
    if (!unique.length) return new Map();
    const query = this.attributes.find({ key: { $in: unique } });
    if (session) query.session(session);
    const entries = await query.lean().exec();
    return new Map(entries.map((entry) => [entry.key, entry as unknown as RegistryAttribute]));
  }

  private async baseVersion(draft: { basedOnVersionId?: Types.ObjectId | null }, session?: ClientSession): Promise<{ fields: FieldDefinition[]; allowedAmenityCodes?: string[] } | undefined> {
    if (!draft.basedOnVersionId) return undefined;
    const query = this.versions.findOne({ _id: draft.basedOnVersionId });
    if (session) query.session(session);
    const base = await query.lean().exec();
    if (!base) return undefined;
    return { fields: base.fields ?? [], allowedAmenityCodes: base.allowedAmenityCodes };
  }

  /** The catalog entries `allowedAmenityCodes` names, for membership/active-status checks (Phase 11). Undefined input means "no list to check" — no query. */
  private async amenityCatalogFor(codes: readonly string[] | undefined, session?: ClientSession): Promise<Map<string, AmenityCatalogEntry> | undefined> {
    if (codes === undefined) return undefined;
    const unique = [...new Set(codes.filter((code) => typeof code === 'string' && code))];
    if (!unique.length) return new Map();
    const query = this.amenities.find({ code: { $in: unique } });
    if (session) query.session(session);
    const entries = await query.lean().exec();
    return new Map(entries.map((entry) => [entry.code, { code: entry.code, isActive: entry.isActive !== false }]));
  }

  private async validationErrors(content: FormVersionContent, draft: { basedOnVersionId?: Types.ObjectId | null }, session?: ClientSession): Promise<FormDraftError[]> {
    const registry = await this.registry(content.fields.map((field) => field.key), session);
    const base = await this.baseVersion(draft, session);
    return validateFormContent(content, registry, {
      baseFields: base?.fields ?? [],
      amenityCatalog: await this.amenityCatalogFor(content.allowedAmenityCodes, session),
      baseAllowedAmenityCodes: base?.allowedAmenityCodes ?? [],
    });
  }

  private record(session: ClientSession, actor: FormAdminActor, action: AuditAction, definitionId: Types.ObjectId, reason: string, metadata: Record<string, unknown>) {
    return this.audit.logRequired({ action, actorUserId: actor.userId, targetResourceId: String(definitionId), reason, ip: actor.ip, metadata }, session);
  }
}

// ------------------------------------------------------------ errors

const notFound = () => new NotFoundException({ message: 'نموذج نوع العقار غير موجود', code: FormDefinitionErrorCode.NOT_FOUND });
const draftNotFound = () => new NotFoundException({ message: 'لا توجد مسودة مفتوحة لهذا النموذج', code: FormDefinitionErrorCode.DRAFT_NOT_FOUND });
const archived = () => new ConflictException({ message: 'النموذج موقوف؛ أعد تفعيله أولاً', code: FormDefinitionErrorCode.ARCHIVED });
const currentVersionInvalid = () => new ConflictException({ message: 'النسخة المنشورة الحالية للنموذج غير سليمة', code: FormDefinitionErrorCode.CURRENT_VERSION_INVALID });
const typeNotEligible = (reason: 'TYPE_NOT_FOUND' | 'TYPE_NOT_MAPPED') => new BadRequestException({
  message: 'نوع العقار غير موجود أو غير مرتبط بغرض', code: FormDefinitionErrorCode.TYPE_NOT_ELIGIBLE, details: { reason },
});
const versionConflict = (token: 'expectedVersion' | 'expectedDraftRevision', current: number) => new ConflictException({
  message: 'تم تعديل النموذج بواسطة طلب آخر؛ أعد تحميل البيانات', code: FormDefinitionErrorCode.VERSION_CONFLICT, details: { token, current },
});
const draftInvalid = (code: FormDefinitionErrorCode, errors: FormDraftError[]) => new BadRequestException({
  message: 'محتوى النموذج غير صالح', code, details: { errors },
});

function assertHeadVersion(head: { version?: number }, expected: number) {
  if ((head.version ?? 0) !== expected) throw versionConflict('expectedVersion', head.version ?? 0);
}

function assertDraftRevision(draft: { draftRevision?: number }, expected: number) {
  if ((draft.draftRevision ?? 0) !== expected) throw versionConflict('expectedDraftRevision', draft.draftRevision ?? 0);
}

// ------------------------------------------------------------ views

const idOrNull = (value: unknown) => (value ? String(value) : null);

function headView(head: any) {
  return {
    definitionId: String(head._id),
    purposeSubcategoryId: String(head.purposeSubcategoryId),
    status: head.status,
    version: head.version ?? 0,
    currentVersionId: idOrNull(head.currentVersionId),
    currentVersion: head.currentVersion ?? null,
    nextVersionNumber: head.nextVersionNumber,
    draftVersionId: idOrNull(head.draftVersionId),
    archivedAt: head.archivedAt ?? null,
    archivedBy: idOrNull(head.archivedBy),
    archivedReason: head.archivedReason ?? null,
    createdAt: head.createdAt ?? null,
    updatedAt: head.updatedAt ?? null,
  };
}

function typeView(type: any) {
  return { id: String(type._id), code: type.code, nameAr: type.nameAr, nameEn: type.nameEn ?? null, isActive: type.isActive !== false, purposeCategoryId: idOrNull(type.purposeCategoryId) };
}

function versionSummary(version: any) {
  return {
    versionId: String(version._id),
    state: version.state,
    version: version.version ?? null,
    contentHash: version.contentHash ?? null,
    legacyWritable: version.legacyWritable ?? null,
    rendererVersion: version.rendererVersion ?? null,
    publishedAt: version.publishedAt ?? null,
    publishedBy: idOrNull(version.publishedBy),
    supersededAt: version.supersededAt ?? null,
  };
}

function versionView(version: any) {
  const content = version.state === 'draft' ? publishableContent(version) : storedContent(version);
  return {
    ...versionSummary(version),
    definitionId: String(version.definitionId),
    purposeSubcategoryId: String(version.purposeSubcategoryId),
    mediaProfile: version.mediaProfile,
    amenitiesEnabled: version.amenitiesEnabled,
    allowedAmenityCodes: version.allowedAmenityCodes ?? null,
    fields: content.fields,
    changeNote: version.changeNote ?? null,
    basedOnVersionId: idOrNull(version.basedOnVersionId),
    draftRevision: version.draftRevision ?? 0,
    createdAt: version.createdAt ?? null,
    updatedAt: version.updatedAt ?? null,
  };
}

function attributeView(item: any) {
  return {
    key: item.key,
    dataType: item.dataType,
    unit: item.unit ?? null,
    labelAr: item.labelAr,
    labelEn: item.labelEn ?? null,
    hardBounds: Object.fromEntries(Object.entries(item.hardBounds ?? {}).filter(([, value]) => value !== undefined && value !== null)),
    optionSource: item.optionSource ?? null,
    catalogGroup: item.catalogGroup ?? null,
    options: (item.options ?? []).map((option: any) => ({ code: option.code, labelAr: option.labelAr, labelEn: option.labelEn ?? null, status: option.status })),
    facetKey: item.facetKey ?? null,
    status: item.status,
    origin: item.origin,
  };
}
