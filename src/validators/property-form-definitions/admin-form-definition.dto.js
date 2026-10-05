'use strict';

const { Type } = require('class-transformer');
const {
  Allow,
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} = require('class-validator');
const {
  MEDIA_PROFILES,
  PROPERTY_FORM_LIMITS,
} = require('../../domain/property-form-definitions/property-form-definition.constants');
/** Transport cap on the allowed-amenities list; the domain validator enforces catalog membership. */
const TRANSPORT_MAX_AMENITY_CODES = 100;
/**
 * DPF-030..032 Admin request bodies. Only the frozen editable properties
 * exist here; with the global whitelist + forbidNonWhitelisted pipe, any
 * attempt to send identity (dataType, unit, optionSource, catalogGroup),
 * search/index flags, regex or conditional rules is a 400. The transport caps
 * are deliberately looser than the contract so the domain validator can
 * answer with structured, per-field errors; they only bound the payload.
 */
const TRANSPORT_MAX_FIELDS = 200;
const TRANSPORT_MAX_OPTIONS = 200;
const TRANSPORT_MAX_TEXT = 1000;
class CreateFormDefinitionDto {}
IsMongoId()(CreateFormDefinitionDto.prototype, 'purposeSubcategoryId');
class ExpectedFormVersionDto {}
Min(0)(ExpectedFormVersionDto.prototype, 'expectedVersion');
IsInt()(ExpectedFormVersionDto.prototype, 'expectedVersion');
class DiscardFormDraftDto extends ExpectedFormVersionDto {}
Min(0)(DiscardFormDraftDto.prototype, 'expectedDraftRevision');
IsInt()(DiscardFormDraftDto.prototype, 'expectedDraftRevision');
class PublishFormDraftDto extends ExpectedFormVersionDto {}
Min(0)(PublishFormDraftDto.prototype, 'expectedDraftRevision');
IsInt()(PublishFormDraftDto.prototype, 'expectedDraftRevision');
class ArchiveFormDefinitionDto extends ExpectedFormVersionDto {}
MaxLength(PROPERTY_FORM_LIMITS.archiveReasonMaxLength)(
  ArchiveFormDefinitionDto.prototype,
  'reason',
);
IsNotEmpty()(ArchiveFormDefinitionDto.prototype, 'reason');
IsString()(ArchiveFormDefinitionDto.prototype, 'reason');
class FormFieldValidationDto {}
Allow()(FormFieldValidationDto.prototype, 'min');
IsOptional()(FormFieldValidationDto.prototype, 'min');
Allow()(FormFieldValidationDto.prototype, 'max');
IsOptional()(FormFieldValidationDto.prototype, 'max');
IsInt()(FormFieldValidationDto.prototype, 'scale');
IsOptional()(FormFieldValidationDto.prototype, 'scale');
IsInt()(FormFieldValidationDto.prototype, 'minLength');
IsOptional()(FormFieldValidationDto.prototype, 'minLength');
IsInt()(FormFieldValidationDto.prototype, 'maxLength');
IsOptional()(FormFieldValidationDto.prototype, 'maxLength');
IsInt()(FormFieldValidationDto.prototype, 'minItems');
IsOptional()(FormFieldValidationDto.prototype, 'minItems');
IsInt()(FormFieldValidationDto.prototype, 'maxItems');
IsOptional()(FormFieldValidationDto.prototype, 'maxItems');
class FormFieldOptionDto {}
MaxLength(TRANSPORT_MAX_TEXT)(FormFieldOptionDto.prototype, 'code');
IsString()(FormFieldOptionDto.prototype, 'code');
MaxLength(TRANSPORT_MAX_TEXT)(FormFieldOptionDto.prototype, 'labelAr');
IsString()(FormFieldOptionDto.prototype, 'labelAr');
IsOptional()(FormFieldOptionDto.prototype, 'labelAr');
MaxLength(TRANSPORT_MAX_TEXT)(FormFieldOptionDto.prototype, 'labelEn');
IsString()(FormFieldOptionDto.prototype, 'labelEn');
IsOptional()(FormFieldOptionDto.prototype, 'labelEn');
IsInt()(FormFieldOptionDto.prototype, 'order');
class FormFieldDto {}
MaxLength(TRANSPORT_MAX_TEXT)(FormFieldDto.prototype, 'key');
IsString()(FormFieldDto.prototype, 'key');
MaxLength(TRANSPORT_MAX_TEXT)(FormFieldDto.prototype, 'labelAr');
IsString()(FormFieldDto.prototype, 'labelAr');
MaxLength(TRANSPORT_MAX_TEXT)(FormFieldDto.prototype, 'labelEn');
IsString()(FormFieldDto.prototype, 'labelEn');
IsOptional()(FormFieldDto.prototype, 'labelEn');
MaxLength(TRANSPORT_MAX_TEXT)(FormFieldDto.prototype, 'helpAr');
IsString()(FormFieldDto.prototype, 'helpAr');
IsOptional()(FormFieldDto.prototype, 'helpAr');
MaxLength(TRANSPORT_MAX_TEXT)(FormFieldDto.prototype, 'helpEn');
IsString()(FormFieldDto.prototype, 'helpEn');
IsOptional()(FormFieldDto.prototype, 'helpEn');
MaxLength(TRANSPORT_MAX_TEXT)(FormFieldDto.prototype, 'placeholderAr');
IsString()(FormFieldDto.prototype, 'placeholderAr');
IsOptional()(FormFieldDto.prototype, 'placeholderAr');
IsBoolean()(FormFieldDto.prototype, 'required');
IsInt()(FormFieldDto.prototype, 'order');
IsString({ each: true })(FormFieldDto.prototype, 'operations');
ArrayMaxSize(10)(FormFieldDto.prototype, 'operations');
IsArray()(FormFieldDto.prototype, 'operations');
IsOptional()(FormFieldDto.prototype, 'operations');
MaxLength(TRANSPORT_MAX_TEXT)(FormFieldDto.prototype, 'widget');
IsString()(FormFieldDto.prototype, 'widget');
IsOptional()(FormFieldDto.prototype, 'widget');
Type(() => FormFieldValidationDto)(FormFieldDto.prototype, 'validation');
ValidateNested()(FormFieldDto.prototype, 'validation');
IsOptional()(FormFieldDto.prototype, 'validation');
Type(() => FormFieldOptionDto)(FormFieldDto.prototype, 'options');
ValidateNested({ each: true })(FormFieldDto.prototype, 'options');
ArrayMaxSize(TRANSPORT_MAX_OPTIONS)(FormFieldDto.prototype, 'options');
IsArray()(FormFieldDto.prototype, 'options');
IsOptional()(FormFieldDto.prototype, 'options');
/** Full replacement of the draft's content (no partial patches: the result is always one whole, validated form). */
class UpdateFormDraftDto {}
Min(0)(UpdateFormDraftDto.prototype, 'expectedDraftRevision');
IsInt()(UpdateFormDraftDto.prototype, 'expectedDraftRevision');
Type(() => FormFieldDto)(UpdateFormDraftDto.prototype, 'fields');
ValidateNested({ each: true })(UpdateFormDraftDto.prototype, 'fields');
ArrayMaxSize(TRANSPORT_MAX_FIELDS)(UpdateFormDraftDto.prototype, 'fields');
IsArray()(UpdateFormDraftDto.prototype, 'fields');
IsIn(MEDIA_PROFILES)(UpdateFormDraftDto.prototype, 'mediaProfile');
IsString()(UpdateFormDraftDto.prototype, 'mediaProfile');
IsBoolean()(UpdateFormDraftDto.prototype, 'amenitiesEnabled');
IsString({ each: true })(UpdateFormDraftDto.prototype, 'allowedAmenityCodes');
ArrayMaxSize(TRANSPORT_MAX_AMENITY_CODES)(UpdateFormDraftDto.prototype, 'allowedAmenityCodes');
IsArray()(UpdateFormDraftDto.prototype, 'allowedAmenityCodes');
IsOptional()(UpdateFormDraftDto.prototype, 'allowedAmenityCodes');
MaxLength(PROPERTY_FORM_LIMITS.changeNoteMaxLength)(UpdateFormDraftDto.prototype, 'changeNote');
IsString()(UpdateFormDraftDto.prototype, 'changeNote');
IsOptional()(UpdateFormDraftDto.prototype, 'changeNote');

Object.assign(exports, {
  CreateFormDefinitionDto,
  ExpectedFormVersionDto,
  DiscardFormDraftDto,
  PublishFormDraftDto,
  ArchiveFormDefinitionDto,
  FormFieldValidationDto,
  FormFieldOptionDto,
  FormFieldDto,
  UpdateFormDraftDto,
});
