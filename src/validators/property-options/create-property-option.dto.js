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
class CreatePropertyOptionDto {}
IsIn(PROPERTY_OPTION_GROUPS)(CreatePropertyOptionDto.prototype, 'group');
IsString()(CreatePropertyOptionDto.prototype, 'group');
MaxLength(100)(CreatePropertyOptionDto.prototype, 'nameAr');
IsNotEmpty()(CreatePropertyOptionDto.prototype, 'nameAr');
IsString()(CreatePropertyOptionDto.prototype, 'nameAr');
MaxLength(100)(CreatePropertyOptionDto.prototype, 'nameEn');
IsNotEmpty()(CreatePropertyOptionDto.prototype, 'nameEn');
IsString()(CreatePropertyOptionDto.prototype, 'nameEn');
MaxLength(500)(CreatePropertyOptionDto.prototype, 'descriptionAr');
IsString()(CreatePropertyOptionDto.prototype, 'descriptionAr');
IsOptional()(CreatePropertyOptionDto.prototype, 'descriptionAr');
IsIn(PROPERTY_OPTION_ICON_KEYS, { message: 'مفتاح الأيقونة غير مدعوم' })(
  CreatePropertyOptionDto.prototype,
  'iconKey',
);
IsString()(CreatePropertyOptionDto.prototype, 'iconKey');
IsBoolean()(CreatePropertyOptionDto.prototype, 'isActive');
IsOptional()(CreatePropertyOptionDto.prototype, 'isActive');
IsBoolean()(CreatePropertyOptionDto.prototype, 'isDefault');
IsOptional()(CreatePropertyOptionDto.prototype, 'isDefault');
Min(0)(CreatePropertyOptionDto.prototype, 'sortOrder');
IsInt()(CreatePropertyOptionDto.prototype, 'sortOrder');
IsOptional()(CreatePropertyOptionDto.prototype, 'sortOrder');

Object.assign(exports, { CreatePropertyOptionDto });
