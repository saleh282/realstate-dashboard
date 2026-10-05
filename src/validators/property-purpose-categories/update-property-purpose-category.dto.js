'use strict';

const {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} = require('class-validator');
class UpdatePropertyPurposeCategoryDto {}
Min(1)(UpdatePropertyPurposeCategoryDto.prototype, 'expectedVersion');
IsInt()(UpdatePropertyPurposeCategoryDto.prototype, 'expectedVersion');
MaxLength(100)(UpdatePropertyPurposeCategoryDto.prototype, 'nameAr');
IsNotEmpty()(UpdatePropertyPurposeCategoryDto.prototype, 'nameAr');
IsString()(UpdatePropertyPurposeCategoryDto.prototype, 'nameAr');
IsOptional()(UpdatePropertyPurposeCategoryDto.prototype, 'nameAr');
MaxLength(100)(UpdatePropertyPurposeCategoryDto.prototype, 'nameEn');
IsNotEmpty()(UpdatePropertyPurposeCategoryDto.prototype, 'nameEn');
IsString()(UpdatePropertyPurposeCategoryDto.prototype, 'nameEn');
IsOptional()(UpdatePropertyPurposeCategoryDto.prototype, 'nameEn');
MaxLength(500)(UpdatePropertyPurposeCategoryDto.prototype, 'descriptionAr');
IsString()(UpdatePropertyPurposeCategoryDto.prototype, 'descriptionAr');
IsOptional()(UpdatePropertyPurposeCategoryDto.prototype, 'descriptionAr');
IsBoolean()(UpdatePropertyPurposeCategoryDto.prototype, 'isActive');
IsOptional()(UpdatePropertyPurposeCategoryDto.prototype, 'isActive');
Max(10000)(UpdatePropertyPurposeCategoryDto.prototype, 'sortOrder');
Min(0)(UpdatePropertyPurposeCategoryDto.prototype, 'sortOrder');
IsInt()(UpdatePropertyPurposeCategoryDto.prototype, 'sortOrder');
IsOptional()(UpdatePropertyPurposeCategoryDto.prototype, 'sortOrder');

Object.assign(exports, { UpdatePropertyPurposeCategoryDto });
