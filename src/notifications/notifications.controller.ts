import { Body, Controller, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { NotificationErrorCode } from '../common/errors/notification-error-codes';
import { ListNotificationsDto } from './dto/list-notifications.dto';
import { notificationValidation } from './dto/notification-validation.pipe';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}
  @Get() list(@Req() req: any, @Query(notificationValidation(ListNotificationsDto, NotificationErrorCode.QUERY_INVALID)) query: Record<string, any>) { return this.service.list(req.user.userId, query as ListNotificationsDto); }
  @Get('unread-count') unreadCount(@Req() req: any) { return this.service.unreadCount(req.user.userId); }
  @Get('preferences') preferences(@Req() req: any) { return this.service.getPreferences(req.user.userId); }
  @Patch('preferences') updatePreferences(@Req() req: any, @Body(notificationValidation(UpdateNotificationPreferencesDto, NotificationErrorCode.PREFERENCE_INVALID)) dto: Record<string, any>) { return this.service.updatePreferences(req.user.userId, dto as UpdateNotificationPreferencesDto); }
  @Patch('read-all') markAllRead(@Req() req: any) { return this.service.markAllRead(req.user.userId); }
  @Patch(':notificationId/read') markRead(@Req() req: any, @Param('notificationId') notificationId: string) { return this.service.markRead(req.user.userId, notificationId); }
}
