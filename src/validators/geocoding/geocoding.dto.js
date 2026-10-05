'use strict';

const { Transform, Type } = require('class-transformer');
const { IsIn, IsNumber, IsString, Max, MaxLength, Min, MinLength } = require('class-validator');
const trimmed = ({ value }) => String(value ?? '').trim();
const language = ({ value }) => String(value ?? 'ar').trim();
class ReverseGeocodingQueryDto {
  constructor() {
    this.language = 'ar';
  }
}
Max(31.7)(ReverseGeocodingQueryDto.prototype, 'latitude');
Min(21.7)(ReverseGeocodingQueryDto.prototype, 'latitude');
IsNumber()(ReverseGeocodingQueryDto.prototype, 'latitude');
Type(() => Number)(ReverseGeocodingQueryDto.prototype, 'latitude');
Max(36.9)(ReverseGeocodingQueryDto.prototype, 'longitude');
Min(24.6)(ReverseGeocodingQueryDto.prototype, 'longitude');
IsNumber()(ReverseGeocodingQueryDto.prototype, 'longitude');
Type(() => Number)(ReverseGeocodingQueryDto.prototype, 'longitude');
IsIn(['ar', 'en'])(ReverseGeocodingQueryDto.prototype, 'language');
Transform(language)(ReverseGeocodingQueryDto.prototype, 'language');
class SearchGeocodingQueryDto {
  constructor() {
    this.language = 'ar';
  }
}
MaxLength(120)(SearchGeocodingQueryDto.prototype, 'query');
MinLength(3)(SearchGeocodingQueryDto.prototype, 'query');
IsString()(SearchGeocodingQueryDto.prototype, 'query');
Transform(trimmed)(SearchGeocodingQueryDto.prototype, 'query');
IsIn(['ar', 'en'])(SearchGeocodingQueryDto.prototype, 'language');
Transform(language)(SearchGeocodingQueryDto.prototype, 'language');

Object.assign(exports, { ReverseGeocodingQueryDto, SearchGeocodingQueryDto });
