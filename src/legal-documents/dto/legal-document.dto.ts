import { Type } from 'class-transformer';
import {
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
} from 'class-validator';
import { LegalDocumentType } from '../legal-document.types';

export class LegalDocumentSectionDto {
  @IsString() @IsNotEmpty() @MaxLength(200) headingAr: string;
  @IsString() @IsNotEmpty() @MaxLength(200) headingEn: string;
  @IsString() @IsNotEmpty() @MaxLength(10000) bodyAr: string;
  @IsString() @IsNotEmpty() @MaxLength(10000) bodyEn: string;
}

export class CreateLegalDocumentDraftDto {
  @IsEnum(LegalDocumentType, { message: 'نوع المستند غير مدعوم' })
  type: LegalDocumentType;

  // Start from the live version's text instead of supplying the content.
  @IsOptional() @IsBoolean() copyFromPublished?: boolean;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200) titleAr?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200) titleEn?: string;

  @IsOptional()
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(60)
  @ValidateNested({ each: true }) @Type(() => LegalDocumentSectionDto)
  sections?: LegalDocumentSectionDto[];

  @IsOptional() @IsString() @MaxLength(500) changeSummary?: string;
}

export class UpdateLegalDocumentDraftDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200) titleAr?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200) titleEn?: string;

  @IsOptional()
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(60)
  @ValidateNested({ each: true }) @Type(() => LegalDocumentSectionDto)
  sections?: LegalDocumentSectionDto[];

  @IsOptional() @IsString() @MaxLength(500) changeSummary?: string;
}

export class ListLegalDocumentsQueryDto {
  @IsOptional()
  @IsEnum(LegalDocumentType, { message: 'نوع المستند غير مدعوم' })
  type?: LegalDocumentType;
}
