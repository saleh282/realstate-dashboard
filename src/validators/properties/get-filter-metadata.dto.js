'use strict';

const { IsMongoId, IsOptional } = require('class-validator');
/** `GET /properties/filter-metadata`. No type context means no applicable non-residential facets. */
class GetFilterMetadataDto {}
IsMongoId()(GetFilterMetadataDto.prototype, 'purposeSubcategoryId');
IsOptional()(GetFilterMetadataDto.prototype, 'purposeSubcategoryId');

Object.assign(exports, { GetFilterMetadataDto });
