'use strict';

const { Type } = require('class-transformer');
const {
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} = require('class-validator');
const { GOVERNORATE_ICON_KEYS } = require('../../domain/governorates/governorate.constants');
const { MapViewportDto } = require('./map-viewport.dto');
class CreateGovernorateDto {}
MaxLength(100)(CreateGovernorateDto.prototype, 'nameAr');
IsNotEmpty()(CreateGovernorateDto.prototype, 'nameAr');
IsString()(CreateGovernorateDto.prototype, 'nameAr');
MaxLength(100)(CreateGovernorateDto.prototype, 'nameEn');
IsNotEmpty()(CreateGovernorateDto.prototype, 'nameEn');
IsString()(CreateGovernorateDto.prototype, 'nameEn');
IsIn(GOVERNORATE_ICON_KEYS)(CreateGovernorateDto.prototype, 'iconKey');
IsString()(CreateGovernorateDto.prototype, 'iconKey');
IsBoolean()(CreateGovernorateDto.prototype, 'isActive');
IsOptional()(CreateGovernorateDto.prototype, 'isActive');
Min(0)(CreateGovernorateDto.prototype, 'sortOrder');
IsInt()(CreateGovernorateDto.prototype, 'sortOrder');
IsOptional()(CreateGovernorateDto.prototype, 'sortOrder');
Type(() => MapViewportDto)(CreateGovernorateDto.prototype, 'mapViewport');
ValidateNested()(CreateGovernorateDto.prototype, 'mapViewport');
IsDefined()(CreateGovernorateDto.prototype, 'mapViewport');

Object.assign(exports, { CreateGovernorateDto });
