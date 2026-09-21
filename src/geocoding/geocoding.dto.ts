import { Transform, Type } from 'class-transformer';
import { IsIn, IsNumber, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

const trimmed = ({ value }: { value: unknown }) => String(value ?? '').trim();
const language = ({ value }: { value: unknown }) => String(value ?? 'ar').trim();

export class ReverseGeocodingQueryDto {
  @Type(() => Number) @IsNumber() @Min(21.7) @Max(31.7) latitude: number;
  @Type(() => Number) @IsNumber() @Min(24.6) @Max(36.9) longitude: number;
  @Transform(language) @IsIn(['ar', 'en']) language = 'ar';
}

export class SearchGeocodingQueryDto {
  @Transform(trimmed) @IsString() @MinLength(3) @MaxLength(120) query: string;
  @Transform(language) @IsIn(['ar', 'en']) language = 'ar';
}
