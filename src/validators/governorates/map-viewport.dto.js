'use strict';

const { Type } = require('class-transformer');
const { IsNumber, Max, Min, ValidateNested } = require('class-validator');
class MapCoordinateDto {}
Max(90)(MapCoordinateDto.prototype, 'latitude');
Min(-90)(MapCoordinateDto.prototype, 'latitude');
IsNumber()(MapCoordinateDto.prototype, 'latitude');
Max(180)(MapCoordinateDto.prototype, 'longitude');
Min(-180)(MapCoordinateDto.prototype, 'longitude');
IsNumber()(MapCoordinateDto.prototype, 'longitude');
class MapBoundsDto {}
Type(() => MapCoordinateDto)(MapBoundsDto.prototype, 'southWest');
ValidateNested()(MapBoundsDto.prototype, 'southWest');
Type(() => MapCoordinateDto)(MapBoundsDto.prototype, 'northEast');
ValidateNested()(MapBoundsDto.prototype, 'northEast');
class MapViewportDto {}
Type(() => MapCoordinateDto)(MapViewportDto.prototype, 'center');
ValidateNested()(MapViewportDto.prototype, 'center');
Type(() => MapBoundsDto)(MapViewportDto.prototype, 'bounds');
ValidateNested()(MapViewportDto.prototype, 'bounds');

Object.assign(exports, { MapCoordinateDto, MapBoundsDto, MapViewportDto });
