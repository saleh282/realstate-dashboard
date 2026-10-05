'use strict';

const {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} = require('class-validator');
const {
  PROPERTY_OPTION_GROUPS,
  PROPERTY_OPTION_ICON_KEYS,
} = require('../../domain/property-options/property-option.constants');
class UpdatePropertyOptionDto {}
IsIn(PROPERTY_OPTION_GROUPS)(UpdatePropertyOptionDto.prototype, 'group');
IsString()(UpdatePropertyOptionDto.prototype, 'group');
IsOptional()(UpdatePropertyOptionDto.prototype, 'group');
MaxLength(100)(UpdatePropertyOptionDto.prototype, 'nameAr');
IsNotEmpty()(UpdatePropertyOptionDto.prototype, 'nameAr');
IsString()(UpdatePropertyOptionDto.prototype, 'nameAr');
IsOptional()(UpdatePropertyOptionDto.prototype, 'nameAr');
MaxLength(100)(UpdatePropertyOptionDto.prototype, 'nameEn');
IsNotEmpty()(UpdatePropertyOptionDto.prototype, 'nameEn');
IsString()(UpdatePropertyOptionDto.prototype, 'nameEn');
IsOptional()(UpdatePropertyOptionDto.prototype, 'nameEn');
MaxLength(500)(UpdatePropertyOptionDto.prototype, 'descriptionAr');
IsString()(UpdatePropertyOptionDto.prototype, 'descriptionAr');
IsOptional()(UpdatePropertyOptionDto.prototype, 'descriptionAr');
IsIn(PROPERTY_OPTION_ICON_KEYS)(UpdatePropertyOptionDto.prototype, 'iconKey');
IsString()(UpdatePropertyOptionDto.prototype, 'iconKey');
IsOptional()(UpdatePropertyOptionDto.prototype, 'iconKey');
IsBoolean()(UpdatePropertyOptionDto.prototype, 'isActive');
IsOptional()(UpdatePropertyOptionDto.prototype, 'isActive');
IsBoolean()(UpdatePropertyOptionDto.prototype, 'isDefault');
IsOptional()(UpdatePropertyOptionDto.prototype, 'isDefault');
Min(0)(UpdatePropertyOptionDto.prototype, 'sortOrder');
IsInt()(UpdatePropertyOptionDto.prototype, 'sortOrder');
IsOptional()(UpdatePropertyOptionDto.prototype, 'sortOrder');

Object.assign(exports, { UpdatePropertyOptionDto });
