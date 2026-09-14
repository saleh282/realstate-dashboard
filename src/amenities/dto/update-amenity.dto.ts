import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { AMENITY_CATEGORIES, AMENITY_ICON_KEYS } from '../amenity-options';

export class UpdateAmenityDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) nameAr?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) nameEn?: string;
  @IsOptional() @IsString() @MaxLength(500) descriptionAr?: string;
  @IsOptional() @IsString() @IsIn(AMENITY_ICON_KEYS, { message: 'مفتاح الأيقونة غير مدعوم' }) iconKey?: string;
  @IsOptional() @IsString() @IsIn(AMENITY_CATEGORIES, { message: 'تصنيف الميزة غير مدعوم' }) category?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}
