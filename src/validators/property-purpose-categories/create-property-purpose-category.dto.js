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
class CreatePropertyPurposeCategoryDto {}
MaxLength(100)(CreatePropertyPurposeCategoryDto.prototype, 'nameAr');
IsNotEmpty()(CreatePropertyPurposeCategoryDto.prototype, 'nameAr');
IsString()(CreatePropertyPurposeCategoryDto.prototype, 'nameAr');
MaxLength(100)(CreatePropertyPurposeCategoryDto.prototype, 'nameEn');
IsNotEmpty()(CreatePropertyPurposeCategoryDto.prototype, 'nameEn');
IsString()(CreatePropertyPurposeCategoryDto.prototype, 'nameEn');
MaxLength(500)(CreatePropertyPurposeCategoryDto.prototype, 'descriptionAr');
IsString()(CreatePropertyPurposeCategoryDto.prototype, 'descriptionAr');
IsOptional()(CreatePropertyPurposeCategoryDto.prototype, 'descriptionAr');
IsBoolean()(CreatePropertyPurposeCategoryDto.prototype, 'isActive');
IsOptional()(CreatePropertyPurposeCategoryDto.prototype, 'isActive');
Max(10000)(CreatePropertyPurposeCategoryDto.prototype, 'sortOrder');
Min(0)(CreatePropertyPurposeCategoryDto.prototype, 'sortOrder');
IsInt()(CreatePropertyPurposeCategoryDto.prototype, 'sortOrder');
IsOptional()(CreatePropertyPurposeCategoryDto.prototype, 'sortOrder');

Object.assign(exports, { CreatePropertyPurposeCategoryDto });
