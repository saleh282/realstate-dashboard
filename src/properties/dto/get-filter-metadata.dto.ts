import { IsMongoId, IsOptional } from 'class-validator';

/** `GET /properties/filter-metadata`. No type context means no applicable non-residential facets. */
export class GetFilterMetadataDto {
  @IsOptional() @IsMongoId() purposeSubcategoryId?: string;
}
