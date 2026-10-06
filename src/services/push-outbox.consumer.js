'use strict';

const {
  mapNotificationEvent,
  NOTIFICATION_SUBSCRIBED_EVENT_TYPES,
} = require('../domain/notifications/notification-event.mapper');

/** A push about something older than this is no longer news. */
const STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * Pushes each notification to the phones of the account it is for. It reads
 * the same events as the inbox does, on its own, so a push that fails is
 * tried again without the inbox being written twice.
 */
class PushOutboxConsumer {
  constructor(registry, push, clock = () => new Date()) {
    this.registry = registry;
    this.push = push;
    this.clock = clock;
    this.name = 'push';
    this.subscribedTypes = NOTIFICATION_SUBSCRIBED_EVENT_TYPES;
    this.configured = true;
  }
  /** Registers only when pushes can be sent: otherwise its events would pile up unread. */
  onModuleInit() {
    if (this.push.enabled) this.registry.register(this);
  }
  async deliver(event) {
    // Also what keeps a backend that just got its key from pushing its whole history.
    if (this.clock().getTime() - new Date(event.occurredAt).getTime() > STALE_AFTER_MS) return;
    for (const draft of mapNotificationEvent(event)) {
      await this.push.sendToAccount(draft.recipientAccountId, {
        title: draft.title,
        body: draft.message,
        // What the app needs to open the right screen.
        data: { type: draft.type, targetType: draft.target.type, targetId: draft.target.id },
      });
    }
  }
}

module.exports = { PushOutboxConsumer, STALE_AFTER_MS };
