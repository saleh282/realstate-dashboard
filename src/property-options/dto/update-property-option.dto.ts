import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { PROPERTY_OPTION_GROUPS, PROPERTY_OPTION_ICON_KEYS } from '../property-option.constants';
export class UpdatePropertyOptionDto {
  @IsOptional() @IsString() @IsIn(PROPERTY_OPTION_GROUPS) group?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) nameAr?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) nameEn?: string;
  @IsOptional() @IsString() @MaxLength(500) descriptionAr?: string;
  @IsOptional() @IsString() @IsIn(PROPERTY_OPTION_ICON_KEYS) iconKey?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}
