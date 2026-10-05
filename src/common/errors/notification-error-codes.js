'use strict';

var NotificationErrorCode;
(function (NotificationErrorCode) {
  NotificationErrorCode['ID_INVALID'] = 'NOTIFICATION_ID_INVALID';
  NotificationErrorCode['NOT_FOUND'] = 'NOTIFICATION_NOT_FOUND';
  NotificationErrorCode['QUERY_INVALID'] = 'NOTIFICATION_QUERY_INVALID';
  NotificationErrorCode['PREFERENCE_INVALID'] = 'NOTIFICATION_PREFERENCE_INVALID';
})(NotificationErrorCode || (NotificationErrorCode = {}));

Object.assign(exports, { NotificationErrorCode });
