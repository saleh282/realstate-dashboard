'use strict';

class NotificationsController {
  constructor(service) {
    this.service = service;
  }
  list(req, query) {
    return this.service.list(req.user.userId, query);
  }
  unreadCount(req) {
    return this.service.unreadCount(req.user.userId);
  }
  preferences(req) {
    return this.service.getPreferences(req.user.userId);
  }
  updatePreferences(req, dto) {
    return this.service.updatePreferences(req.user.userId, dto);
  }
  markAllRead(req) {
    return this.service.markAllRead(req.user.userId);
  }
  markRead(req, notificationId) {
    return this.service.markRead(req.user.userId, notificationId);
  }
}

Object.assign(exports, { NotificationsController });
