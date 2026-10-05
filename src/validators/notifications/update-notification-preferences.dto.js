'use strict';

const { IsEnum, IsOptional } = require('class-validator');
const { NotificationPreferenceMode } = require('../../domain/notifications/notification.types');
class UpdateNotificationPreferencesDto {}
IsEnum(NotificationPreferenceMode)(UpdateNotificationPreferencesDto.prototype, 'newPropertyAlerts');
IsOptional()(UpdateNotificationPreferencesDto.prototype, 'newPropertyAlerts');

Object.assign(exports, { UpdateNotificationPreferencesDto });
