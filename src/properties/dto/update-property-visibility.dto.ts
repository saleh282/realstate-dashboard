import { IsBoolean } from 'class-validator';

export class UpdatePropertyVisibilityDto {
  @IsBoolean()
  isVisible: boolean;
}
