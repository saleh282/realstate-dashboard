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
class UpdateAmenityDto {}
MaxLength(100)(UpdateAmenityDto.prototype, 'nameAr');
IsNotEmpty()(UpdateAmenityDto.prototype, 'nameAr');
IsString()(UpdateAmenityDto.prototype, 'nameAr');
IsOptional()(UpdateAmenityDto.prototype, 'nameAr');
MaxLength(100)(UpdateAmenityDto.prototype, 'nameEn');
IsNotEmpty()(UpdateAmenityDto.prototype, 'nameEn');
IsString()(UpdateAmenityDto.prototype, 'nameEn');
IsOptional()(UpdateAmenityDto.prototype, 'nameEn');
MaxLength(500)(UpdateAmenityDto.prototype, 'descriptionAr');
IsString()(UpdateAmenityDto.prototype, 'descriptionAr');
IsOptional()(UpdateAmenityDto.prototype, 'descriptionAr');
IsIn(AMENITY_ICON_KEYS, { message: 'مفتاح الأيقونة غير مدعوم' })(
  UpdateAmenityDto.prototype,
  'iconKey',
);
IsString()(UpdateAmenityDto.prototype, 'iconKey');
IsOptional()(UpdateAmenityDto.prototype, 'iconKey');
IsIn(AMENITY_CATEGORIES, { message: 'تصنيف الميزة غير مدعوم' })(
  UpdateAmenityDto.prototype,
  'category',
);
IsString()(UpdateAmenityDto.prototype, 'category');
IsOptional()(UpdateAmenityDto.prototype, 'category');
IsBoolean()(UpdateAmenityDto.prototype, 'isActive');
IsOptional()(UpdateAmenityDto.prototype, 'isActive');
Min(0)(UpdateAmenityDto.prototype, 'sortOrder');
IsInt()(UpdateAmenityDto.prototype, 'sortOrder');
IsOptional()(UpdateAmenityDto.prototype, 'sortOrder');

Object.assign(exports, { UpdateAmenityDto });
