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
const { AMENITY_CATEGORIES, AMENITY_ICON_KEYS } = require('../../domain/amenities/amenity-options');
class CreateAmenityDto {}
MaxLength(100)(CreateAmenityDto.prototype, 'nameAr');
IsNotEmpty()(CreateAmenityDto.prototype, 'nameAr');
IsString()(CreateAmenityDto.prototype, 'nameAr');
MaxLength(100)(CreateAmenityDto.prototype, 'nameEn');
IsNotEmpty()(CreateAmenityDto.prototype, 'nameEn');
IsString()(CreateAmenityDto.prototype, 'nameEn');
MaxLength(500)(CreateAmenityDto.prototype, 'descriptionAr');
IsString()(CreateAmenityDto.prototype, 'descriptionAr');
IsOptional()(CreateAmenityDto.prototype, 'descriptionAr');
IsIn(AMENITY_ICON_KEYS, { message: 'مفتاح الأيقونة غير مدعوم' })(
  CreateAmenityDto.prototype,
  'iconKey',
);
IsString()(CreateAmenityDto.prototype, 'iconKey');
IsIn(AMENITY_CATEGORIES, { message: 'تصنيف الميزة غير مدعوم' })(
  CreateAmenityDto.prototype,
  'category',
);
IsString()(CreateAmenityDto.prototype, 'category');
IsBoolean()(CreateAmenityDto.prototype, 'isActive');
IsOptional()(CreateAmenityDto.prototype, 'isActive');
Min(0)(CreateAmenityDto.prototype, 'sortOrder');
IsInt()(CreateAmenityDto.prototype, 'sortOrder');
IsOptional()(CreateAmenityDto.prototype, 'sortOrder');

Object.assign(exports, { CreateAmenityDto });
