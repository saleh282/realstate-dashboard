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
class CreateCityDto {}
IsMongoId()(CreateCityDto.prototype, 'governorateId');
MaxLength(100)(CreateCityDto.prototype, 'nameAr');
IsNotEmpty()(CreateCityDto.prototype, 'nameAr');
IsString()(CreateCityDto.prototype, 'nameAr');
MaxLength(100)(CreateCityDto.prototype, 'nameEn');
IsNotEmpty()(CreateCityDto.prototype, 'nameEn');
IsString()(CreateCityDto.prototype, 'nameEn');
IsBoolean()(CreateCityDto.prototype, 'isActive');
IsOptional()(CreateCityDto.prototype, 'isActive');
Max(10000)(CreateCityDto.prototype, 'sortOrder');
Min(0)(CreateCityDto.prototype, 'sortOrder');
IsInt()(CreateCityDto.prototype, 'sortOrder');
IsOptional()(CreateCityDto.prototype, 'sortOrder');

Object.assign(exports, { CreateCityDto });
