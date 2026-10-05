'use strict';

const {
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} = require('class-validator');
const { PROPERTY_TYPE_ICON_KEYS } = require('../../domain/property-types/property-type-options');
class CreatePropertyTypeDto {}
IsMongoId()(CreatePropertyTypeDto.prototype, 'purposeCategoryId');
MaxLength(100)(CreatePropertyTypeDto.prototype, 'nameAr');
IsNotEmpty()(CreatePropertyTypeDto.prototype, 'nameAr');
IsString()(CreatePropertyTypeDto.prototype, 'nameAr');
MaxLength(100)(CreatePropertyTypeDto.prototype, 'nameEn');
IsNotEmpty()(CreatePropertyTypeDto.prototype, 'nameEn');
IsString()(CreatePropertyTypeDto.prototype, 'nameEn');
MaxLength(500)(CreatePropertyTypeDto.prototype, 'descriptionAr');
IsString()(CreatePropertyTypeDto.prototype, 'descriptionAr');
IsOptional()(CreatePropertyTypeDto.prototype, 'descriptionAr');
MaxLength(50)(CreatePropertyTypeDto.prototype, 'iconKey');
IsIn(PROPERTY_TYPE_ICON_KEYS, { message: 'مفتاح الأيقونة غير مدعوم' })(
  CreatePropertyTypeDto.prototype,
  'iconKey',
);
IsString()(CreatePropertyTypeDto.prototype, 'iconKey');
IsBoolean()(CreatePropertyTypeDto.prototype, 'isActive');
IsOptional()(CreatePropertyTypeDto.prototype, 'isActive');
Min(0)(CreatePropertyTypeDto.prototype, 'sortOrder');
IsInt()(CreatePropertyTypeDto.prototype, 'sortOrder');
IsOptional()(CreatePropertyTypeDto.prototype, 'sortOrder');

Object.assign(exports, { CreatePropertyTypeDto });
