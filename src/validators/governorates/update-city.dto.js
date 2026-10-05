'use strict';

const {
  IsBoolean,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} = require('class-validator');
class UpdateCityDto {}
IsMongoId()(UpdateCityDto.prototype, 'governorateId');
IsOptional()(UpdateCityDto.prototype, 'governorateId');
MaxLength(100)(UpdateCityDto.prototype, 'nameAr');
IsNotEmpty()(UpdateCityDto.prototype, 'nameAr');
IsString()(UpdateCityDto.prototype, 'nameAr');
IsOptional()(UpdateCityDto.prototype, 'nameAr');
MaxLength(100)(UpdateCityDto.prototype, 'nameEn');
IsNotEmpty()(UpdateCityDto.prototype, 'nameEn');
IsString()(UpdateCityDto.prototype, 'nameEn');
IsOptional()(UpdateCityDto.prototype, 'nameEn');
IsBoolean()(UpdateCityDto.prototype, 'isActive');
IsOptional()(UpdateCityDto.prototype, 'isActive');
Max(10000)(UpdateCityDto.prototype, 'sortOrder');
Min(0)(UpdateCityDto.prototype, 'sortOrder');
IsInt()(UpdateCityDto.prototype, 'sortOrder');
IsOptional()(UpdateCityDto.prototype, 'sortOrder');

Object.assign(exports, { UpdateCityDto });
