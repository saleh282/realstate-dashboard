import { Type } from 'class-transformer';
import { IsBoolean, IsInt, Min } from 'class-validator';

export class UpdatePropertyVisibilityDto {
  @IsBoolean()
  isVisible: boolean;

  @Type(() => Number) @IsInt() @Min(0)
  version: number;
}
