import { IsEnum, IsOptional } from 'class-validator';
import { NotificationPreferenceMode } from '../notification.types';

export class UpdateNotificationPreferencesDto {
  @IsOptional() @IsEnum(NotificationPreferenceMode) newPropertyAlerts?: NotificationPreferenceMode;
  @IsOptional() @IsEnum(NotificationPreferenceMode) auctionOpportunityAlerts?: NotificationPreferenceMode;
}
