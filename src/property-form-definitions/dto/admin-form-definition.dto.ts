import { Type } from 'class-transformer';
import {
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
} from 'class-validator';
import { MEDIA_PROFILES, PROPERTY_FORM_LIMITS } from '../property-form-definition.constants';

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

export class CreateFormDefinitionDto {
  @IsMongoId() purposeSubcategoryId: string;
}

export class ExpectedFormVersionDto {
  @IsInt() @Min(0) expectedVersion: number;
}

export class DiscardFormDraftDto extends ExpectedFormVersionDto {
  @IsInt() @Min(0) expectedDraftRevision: number;
}

export class PublishFormDraftDto extends ExpectedFormVersionDto {
  @IsInt() @Min(0) expectedDraftRevision: number;
}

export class ArchiveFormDefinitionDto extends ExpectedFormVersionDto {
  @IsString() @IsNotEmpty() @MaxLength(PROPERTY_FORM_LIMITS.archiveReasonMaxLength) reason: string;
}

export class FormFieldValidationDto {
  /** Number for integer/decimal, `YYYY-MM-DD` for date; typed by the domain validator. */
  @IsOptional() @Allow() min?: number | string;
  @IsOptional() @Allow() max?: number | string;
  @IsOptional() @IsInt() scale?: number;
  @IsOptional() @IsInt() minLength?: number;
  @IsOptional() @IsInt() maxLength?: number;
  @IsOptional() @IsInt() minItems?: number;
  @IsOptional() @IsInt() maxItems?: number;
}

export class FormFieldOptionDto {
  @IsString() @MaxLength(TRANSPORT_MAX_TEXT) code: string;
  @IsOptional() @IsString() @MaxLength(TRANSPORT_MAX_TEXT) labelAr?: string;
  @IsOptional() @IsString() @MaxLength(TRANSPORT_MAX_TEXT) labelEn?: string;
  @IsInt() order: number;
}

export class FormFieldDto {
  @IsString() @MaxLength(TRANSPORT_MAX_TEXT) key: string;
  @IsString() @MaxLength(TRANSPORT_MAX_TEXT) labelAr: string;
  @IsOptional() @IsString() @MaxLength(TRANSPORT_MAX_TEXT) labelEn?: string;
  @IsOptional() @IsString() @MaxLength(TRANSPORT_MAX_TEXT) helpAr?: string;
  @IsOptional() @IsString() @MaxLength(TRANSPORT_MAX_TEXT) helpEn?: string;
  @IsOptional() @IsString() @MaxLength(TRANSPORT_MAX_TEXT) placeholderAr?: string;
  @IsBoolean() required: boolean;
  @IsInt() order: number;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) operations?: string[];
  @IsOptional() @IsString() @MaxLength(TRANSPORT_MAX_TEXT) widget?: string;
  @IsOptional() @ValidateNested() @Type(() => FormFieldValidationDto) validation?: FormFieldValidationDto;
  @IsOptional() @IsArray() @ArrayMaxSize(TRANSPORT_MAX_OPTIONS) @ValidateNested({ each: true }) @Type(() => FormFieldOptionDto) options?: FormFieldOptionDto[];
}

/** Full replacement of the draft's content (no partial patches: the result is always one whole, validated form). */
export class UpdateFormDraftDto {
  @IsInt() @Min(0) expectedDraftRevision: number;
  @IsArray() @ArrayMaxSize(TRANSPORT_MAX_FIELDS) @ValidateNested({ each: true }) @Type(() => FormFieldDto) fields: FormFieldDto[];
  @IsString() @IsIn(MEDIA_PROFILES) mediaProfile: string;
  @IsBoolean() amenitiesEnabled: boolean;
  @IsOptional() @IsString() @MaxLength(PROPERTY_FORM_LIMITS.changeNoteMaxLength) changeNote?: string;
}
