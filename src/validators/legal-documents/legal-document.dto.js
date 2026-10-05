'use strict';

const { Type } = require('class-transformer');
const {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} = require('class-validator');
const { LegalDocumentType } = require('../../domain/legal-documents/legal-document.types');
class LegalDocumentSectionDto {}
MaxLength(200)(LegalDocumentSectionDto.prototype, 'headingAr');
IsNotEmpty()(LegalDocumentSectionDto.prototype, 'headingAr');
IsString()(LegalDocumentSectionDto.prototype, 'headingAr');
MaxLength(200)(LegalDocumentSectionDto.prototype, 'headingEn');
IsNotEmpty()(LegalDocumentSectionDto.prototype, 'headingEn');
IsString()(LegalDocumentSectionDto.prototype, 'headingEn');
MaxLength(10000)(LegalDocumentSectionDto.prototype, 'bodyAr');
IsNotEmpty()(LegalDocumentSectionDto.prototype, 'bodyAr');
IsString()(LegalDocumentSectionDto.prototype, 'bodyAr');
MaxLength(10000)(LegalDocumentSectionDto.prototype, 'bodyEn');
IsNotEmpty()(LegalDocumentSectionDto.prototype, 'bodyEn');
IsString()(LegalDocumentSectionDto.prototype, 'bodyEn');
class CreateLegalDocumentDraftDto {}
IsEnum(LegalDocumentType, { message: 'نوع المستند غير مدعوم' })(
  CreateLegalDocumentDraftDto.prototype,
  'type',
);
IsBoolean()(CreateLegalDocumentDraftDto.prototype, 'copyFromPublished');
IsOptional()(CreateLegalDocumentDraftDto.prototype, 'copyFromPublished');
MaxLength(200)(CreateLegalDocumentDraftDto.prototype, 'titleAr');
IsNotEmpty()(CreateLegalDocumentDraftDto.prototype, 'titleAr');
IsString()(CreateLegalDocumentDraftDto.prototype, 'titleAr');
IsOptional()(CreateLegalDocumentDraftDto.prototype, 'titleAr');
MaxLength(200)(CreateLegalDocumentDraftDto.prototype, 'titleEn');
IsNotEmpty()(CreateLegalDocumentDraftDto.prototype, 'titleEn');
IsString()(CreateLegalDocumentDraftDto.prototype, 'titleEn');
IsOptional()(CreateLegalDocumentDraftDto.prototype, 'titleEn');
Type(() => LegalDocumentSectionDto)(CreateLegalDocumentDraftDto.prototype, 'sections');
ValidateNested({ each: true })(CreateLegalDocumentDraftDto.prototype, 'sections');
ArrayMaxSize(60)(CreateLegalDocumentDraftDto.prototype, 'sections');
ArrayMinSize(1)(CreateLegalDocumentDraftDto.prototype, 'sections');
IsArray()(CreateLegalDocumentDraftDto.prototype, 'sections');
IsOptional()(CreateLegalDocumentDraftDto.prototype, 'sections');
MaxLength(500)(CreateLegalDocumentDraftDto.prototype, 'changeSummary');
IsString()(CreateLegalDocumentDraftDto.prototype, 'changeSummary');
IsOptional()(CreateLegalDocumentDraftDto.prototype, 'changeSummary');
class UpdateLegalDocumentDraftDto {}
MaxLength(200)(UpdateLegalDocumentDraftDto.prototype, 'titleAr');
IsNotEmpty()(UpdateLegalDocumentDraftDto.prototype, 'titleAr');
IsString()(UpdateLegalDocumentDraftDto.prototype, 'titleAr');
IsOptional()(UpdateLegalDocumentDraftDto.prototype, 'titleAr');
MaxLength(200)(UpdateLegalDocumentDraftDto.prototype, 'titleEn');
IsNotEmpty()(UpdateLegalDocumentDraftDto.prototype, 'titleEn');
IsString()(UpdateLegalDocumentDraftDto.prototype, 'titleEn');
IsOptional()(UpdateLegalDocumentDraftDto.prototype, 'titleEn');
Type(() => LegalDocumentSectionDto)(UpdateLegalDocumentDraftDto.prototype, 'sections');
ValidateNested({ each: true })(UpdateLegalDocumentDraftDto.prototype, 'sections');
ArrayMaxSize(60)(UpdateLegalDocumentDraftDto.prototype, 'sections');
ArrayMinSize(1)(UpdateLegalDocumentDraftDto.prototype, 'sections');
IsArray()(UpdateLegalDocumentDraftDto.prototype, 'sections');
IsOptional()(UpdateLegalDocumentDraftDto.prototype, 'sections');
MaxLength(500)(UpdateLegalDocumentDraftDto.prototype, 'changeSummary');
IsString()(UpdateLegalDocumentDraftDto.prototype, 'changeSummary');
IsOptional()(UpdateLegalDocumentDraftDto.prototype, 'changeSummary');
class ListLegalDocumentsQueryDto {}
IsEnum(LegalDocumentType, { message: 'نوع المستند غير مدعوم' })(
  ListLegalDocumentsQueryDto.prototype,
  'type',
);
IsOptional()(ListLegalDocumentsQueryDto.prototype, 'type');

Object.assign(exports, {
  LegalDocumentSectionDto,
  CreateLegalDocumentDraftDto,
  UpdateLegalDocumentDraftDto,
  ListLegalDocumentsQueryDto,
});
