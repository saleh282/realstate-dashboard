import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { updatedPaths } from '../../common/mongo/update-paths';
import { FORM_DEFINITION_STATUSES, PROPERTY_FORM_LIMITS } from '../property-form-definition.constants';

export type PropertyFormDefinitionDocument = HydratedDocument<PropertyFormDefinition>;

/**
 * FormDefinition head (frozen §A2): exactly one per property type. Pointers
 * (`currentVersionId`/`currentVersion`, `draftVersionId`) change only through
 * the draft/publish lifecycle (DPF-031/032); `nextVersionNumber` only grows;
 * `version` is the head's optimistic-concurrency counter.
 */
@Schema({ timestamps: true, collection: 'property_form_definitions' })
export class PropertyFormDefinition {
  @Prop({ type: Types.ObjectId, ref: 'PropertyType', required: true, immutable: true }) purposeSubcategoryId: Types.ObjectId;
  @Prop({ required: true, enum: FORM_DEFINITION_STATUSES, default: 'active' }) status: string;
  @Prop({ type: Types.ObjectId, ref: 'PropertyFormDefinitionVersion' }) currentVersionId?: Types.ObjectId;
  @Prop({ min: 1 }) currentVersion?: number;
  @Prop({ type: Types.ObjectId, ref: 'PropertyFormDefinitionVersion' }) draftVersionId?: Types.ObjectId;
  @Prop({ required: true, min: 1, default: 1 }) nextVersionNumber: number;
  @Prop({ required: true, min: 0, default: 0 }) version: number;
  @Prop() archivedAt?: Date;
  @Prop({ type: Types.ObjectId, ref: 'User' }) archivedBy?: Types.ObjectId;
  @Prop({ trim: true, maxlength: PROPERTY_FORM_LIMITS.archiveReasonMaxLength }) archivedReason?: string;
  @Prop({ type: Types.ObjectId, ref: 'User' }) createdBy?: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'User' }) updatedBy?: Types.ObjectId;
}

export const PropertyFormDefinitionSchema = SchemaFactory.createForClass(PropertyFormDefinition);
PropertyFormDefinitionSchema.index({ purposeSubcategoryId: 1 }, { unique: true, name: 'property_form_definition_subcategory_unique' });
PropertyFormDefinitionSchema.index({ status: 1, purposeSubcategoryId: 1 }, { name: 'property_form_definition_status' });

export class PropertyFormDefinitionInvariantError extends Error {
  constructor(message: string) { super(`PROPERTY_FORM_DEFINITION_INVARIANT: ${message}`); }
}

const snapshotHead = (doc: any) => {
  doc.$locals.original = { nextVersionNumber: doc.nextVersionNumber, version: doc.version, purposeSubcategoryId: doc.purposeSubcategoryId?.toString() };
};
// Stored counters for the save rules: taken on load and refreshed after every save.
PropertyFormDefinitionSchema.post('init', snapshotHead);
PropertyFormDefinitionSchema.post('save', snapshotHead);

PropertyFormDefinitionSchema.pre('save', function () {
  const original = this.$locals.original as { nextVersionNumber: number; version: number; purposeSubcategoryId?: string } | undefined;
  if (this.isNew || !original) return;
  if (this.nextVersionNumber < original.nextVersionNumber) throw new PropertyFormDefinitionInvariantError('nextVersionNumber only increases');
  if (this.version < original.version) throw new PropertyFormDefinitionInvariantError('version only increases');
});

PropertyFormDefinitionSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], function () {
  const { paths } = updatedPaths(this.getUpdate());
  if (paths.includes('purposeSubcategoryId')) throw new PropertyFormDefinitionInvariantError('purposeSubcategoryId is immutable');
  const update = this.getUpdate() as Record<string, any> | null;
  for (const counter of ['nextVersionNumber', 'version']) {
    const increment = update?.$inc?.[counter];
    if (increment !== undefined && !(increment > 0)) throw new PropertyFormDefinitionInvariantError(`${counter} only increases`);
    if (update?.$set?.[counter] !== undefined || update?.[counter] !== undefined) throw new PropertyFormDefinitionInvariantError(`${counter} changes only through $inc`);
  }
});
PropertyFormDefinitionSchema.pre(['replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'], { query: true, document: false }, function () {
  throw new PropertyFormDefinitionInvariantError('form definition heads are never replaced or deleted');
});
PropertyFormDefinitionSchema.pre('deleteOne', { document: true, query: false }, function () {
  throw new PropertyFormDefinitionInvariantError('form definition heads are never deleted');
});
