import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { AMENITY_CATEGORIES, AMENITY_ICON_KEYS } from '../amenity-options';

export class CreateAmenityDto {
  @IsString() @IsNotEmpty() @MaxLength(100) nameAr: string;
  @IsString() @IsNotEmpty() @MaxLength(100) nameEn: string;
  @IsOptional() @IsString() @MaxLength(500) descriptionAr?: string;
  @IsString() @IsIn(AMENITY_ICON_KEYS, { message: 'مفتاح الأيقونة غير مدعوم' }) iconKey: string;
  @IsString() @IsIn(AMENITY_CATEGORIES, { message: 'تصنيف الميزة غير مدعوم' }) category: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}
