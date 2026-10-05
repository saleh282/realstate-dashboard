'use strict';

const { Type } = require('class-transformer');
const {
  IsBoolean,
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
class UpdateGovernorateDto {}
MaxLength(100)(UpdateGovernorateDto.prototype, 'nameAr');
IsNotEmpty()(UpdateGovernorateDto.prototype, 'nameAr');
IsString()(UpdateGovernorateDto.prototype, 'nameAr');
IsOptional()(UpdateGovernorateDto.prototype, 'nameAr');
MaxLength(100)(UpdateGovernorateDto.prototype, 'nameEn');
IsNotEmpty()(UpdateGovernorateDto.prototype, 'nameEn');
IsString()(UpdateGovernorateDto.prototype, 'nameEn');
IsOptional()(UpdateGovernorateDto.prototype, 'nameEn');
IsIn(GOVERNORATE_ICON_KEYS)(UpdateGovernorateDto.prototype, 'iconKey');
IsString()(UpdateGovernorateDto.prototype, 'iconKey');
IsOptional()(UpdateGovernorateDto.prototype, 'iconKey');
IsBoolean()(UpdateGovernorateDto.prototype, 'isActive');
IsOptional()(UpdateGovernorateDto.prototype, 'isActive');
Min(0)(UpdateGovernorateDto.prototype, 'sortOrder');
IsInt()(UpdateGovernorateDto.prototype, 'sortOrder');
IsOptional()(UpdateGovernorateDto.prototype, 'sortOrder');
Type(() => MapViewportDto)(UpdateGovernorateDto.prototype, 'mapViewport');
ValidateNested()(UpdateGovernorateDto.prototype, 'mapViewport');
IsOptional()(UpdateGovernorateDto.prototype, 'mapViewport');

Object.assign(exports, { UpdateGovernorateDto });
