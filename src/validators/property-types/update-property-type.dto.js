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
class UpdatePropertyTypeDto {}
Min(0)(UpdatePropertyTypeDto.prototype, 'expectedVersion');
IsInt()(UpdatePropertyTypeDto.prototype, 'expectedVersion');
IsMongoId()(UpdatePropertyTypeDto.prototype, 'purposeCategoryId');
IsOptional()(UpdatePropertyTypeDto.prototype, 'purposeCategoryId');
MaxLength(100)(UpdatePropertyTypeDto.prototype, 'nameAr');
IsNotEmpty()(UpdatePropertyTypeDto.prototype, 'nameAr');
IsString()(UpdatePropertyTypeDto.prototype, 'nameAr');
IsOptional()(UpdatePropertyTypeDto.prototype, 'nameAr');
MaxLength(100)(UpdatePropertyTypeDto.prototype, 'nameEn');
IsString()(UpdatePropertyTypeDto.prototype, 'nameEn');
IsOptional()(UpdatePropertyTypeDto.prototype, 'nameEn');
MaxLength(500)(UpdatePropertyTypeDto.prototype, 'descriptionAr');
IsString()(UpdatePropertyTypeDto.prototype, 'descriptionAr');
IsOptional()(UpdatePropertyTypeDto.prototype, 'descriptionAr');
MaxLength(50)(UpdatePropertyTypeDto.prototype, 'iconKey');
IsIn(PROPERTY_TYPE_ICON_KEYS, { message: 'مفتاح الأيقونة غير مدعوم' })(
  UpdatePropertyTypeDto.prototype,
  'iconKey',
);
IsString()(UpdatePropertyTypeDto.prototype, 'iconKey');
IsOptional()(UpdatePropertyTypeDto.prototype, 'iconKey');
IsBoolean()(UpdatePropertyTypeDto.prototype, 'isActive');
IsOptional()(UpdatePropertyTypeDto.prototype, 'isActive');
Min(0)(UpdatePropertyTypeDto.prototype, 'sortOrder');
IsInt()(UpdatePropertyTypeDto.prototype, 'sortOrder');
IsOptional()(UpdatePropertyTypeDto.prototype, 'sortOrder');

Object.assign(exports, { UpdatePropertyTypeDto });
