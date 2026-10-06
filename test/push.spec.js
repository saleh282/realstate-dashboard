'use strict';

const request = require('supertest');
const { Types } = require('mongoose');
const { httpApp } = require('./support/http-app');
const { FakeModel } = require('./support/fake-model');
const { PushService, MAX_DEVICES } = require('../src/services/push.service');
const { PushOutboxConsumer, STALE_AFTER_MS } = require('../src/services/push-outbox.consumer');
const { FcmPushSender } = require('../src/services/fcm-push.sender');
const { OutboxConsumerRegistry } = require('../src/domain/outbox/outbox-consumer.port');
const { listingDecisionEvent, kycDecisionEvent } = require('../src/domain/outbox/outbox-events');

const id = () => new Types.ObjectId().toString();
const token = (name) => `${name}-${'x'.repeat(40)}`;
const rejection = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return { status: error.getStatus(), ...error.getResponse() };
  }
  throw new Error('expected a rejection');
};

function setup({ withSender = true } = {}) {
  const devices = new FakeModel();
  const sender = { send: jest.fn(async () => ({ gone: [] })) };
  const service = new PushService(devices, withSender ? sender : null);
  return { service, devices, sender };
}

describe('the phones of an account', () => {
  it('registers a phone, once however often it is sent', async () => {
    const { service, devices } = setup();
    const user = id();
    await service.register(user, { token: token('a'), platform: 'android' });
    await service.register(user, { token: ` ${token('a')} `, platform: 'android' });
    await service.register(user, { token: token('b'), platform: 'ios' });
    expect(devices.docs.map((doc) => doc.platform)).toEqual(['android', 'ios']);
  });
  it('moves a phone to whoever signs in on it', async () => {
    const { service, devices } = setup();
    const [first, second] = [id(), id()];
    await service.register(first, { token: token('a'), platform: 'android' });
    await service.register(second, { token: token('a'), platform: 'android' });
    expect(devices.docs).toHaveLength(1);
    expect(String(devices.docs[0].userId)).toBe(second);
  });
  it('refuses a token or a platform that cannot be one', async () => {
    const { service } = setup();
    for (const body of [
      undefined,
      {},
      { token: 'short', platform: 'android' },
      { token: token('a'), platform: 'windows' },
      { token: 'x'.repeat(5000), platform: 'ios' },
    ]) {
      expect(await rejection(service.register(id(), body))).toMatchObject({
        status: 400,
        code: 'NOTIFICATION_DEVICE_INVALID',
      });
    }
  });
  it('keeps only the most recent phones of an account', async () => {
    const { service, devices } = setup();
    const user = id();
    for (let i = 0; i < MAX_DEVICES + 2; i++) {
      await service.register(user, { token: token(`phone${i}`), platform: 'android' });
      devices.docs.at(-1).updatedAt = new Date(2026, 0, 1 + i);
    }
    await service.register(user, { token: token('newest'), platform: 'android' });
    expect(devices.docs.length).toBeLessThanOrEqual(MAX_DEVICES);
    expect(devices.docs.some((doc) => doc.token === token('newest'))).toBe(true);
    expect(devices.docs.some((doc) => doc.token === token('phone0'))).toBe(false);
  });
  it('forgets a phone on sign-out, also one it never knew', async () => {
    const { service, devices } = setup();
    await service.register(id(), { token: token('a'), platform: 'android' });
    await service.unregister({ token: token('a') });
    await service.unregister({ token: token('a') });
    expect(devices.docs).toHaveLength(0);
    expect((await rejection(service.unregister({}))).status).toBe(400);
  });
});

describe('pushing to an account', () => {
  it('sends to every phone of the account and to no one else', async () => {
    const { service, sender } = setup();
    const [user, other] = [id(), id()];
    await service.register(user, { token: token('a'), platform: 'android' });
    await service.register(user, { token: token('b'), platform: 'ios' });
    await service.register(other, { token: token('c'), platform: 'android' });
    const message = { title: 'عنوان', body: 'نص', data: { type: 'X' } };
    expect(await service.sendToAccount(user, message)).toEqual({ sent: 2 });
    expect(sender.send).toHaveBeenCalledWith([token('a'), token('b')], message);
  });
  it('forgets the phones that are gone', async () => {
    const { service, sender, devices } = setup();
    const user = id();
    await service.register(user, { token: token('a'), platform: 'android' });
    await service.register(user, { token: token('b'), platform: 'android' });
    sender.send.mockResolvedValueOnce({ gone: [token('a')] });
    expect(await service.sendToAccount(user, { title: 't', body: 'b' })).toEqual({ sent: 1 });
    expect(devices.docs.map((doc) => doc.token)).toEqual([token('b')]);
  });
  it('sends nothing without phones, or without a push key', async () => {
    const { service, sender } = setup();
    expect(await service.sendToAccount(id(), { title: 't', body: 'b' })).toEqual({ sent: 0 });
    expect(sender.send).not.toHaveBeenCalled();
    const off = setup({ withSender: false });
    await off.service.register(id(), { token: token('a'), platform: 'android' });
    expect(off.service.enabled).toBe(false);
    expect(await off.service.sendToAccount(id(), { title: 't', body: 'b' })).toEqual({ sent: 0 });
  });
});

describe('the Firebase sender', () => {
  const sent = (responses) => ({
    sendEachForMulticast: jest.fn(async () => ({ responses })),
  });
  const failed = (code) => ({ success: false, error: { code } });
  it('sends title, body and string data, and names the tokens that are gone', async () => {
    const messaging = sent([
      { success: true },
      failed('messaging/registration-token-not-registered'),
      failed('messaging/internal-error'),
    ]);
    const result = await new FcmPushSender(messaging).send(['a', 'b', 'c'], {
      title: 'عنوان',
      body: 'نص',
      data: { targetId: 5, type: 'LISTING_APPROVED' },
    });
    expect(result).toEqual({ gone: ['b'] });
    expect(messaging.sendEachForMulticast).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: ['a', 'b', 'c'],
        notification: { title: 'عنوان', body: 'نص' },
        data: { targetId: '5', type: 'LISTING_APPROVED' },
      }),
    );
  });
  it('fails, to be tried again, only when no phone could be reached', async () => {
    const messaging = sent([
      failed('messaging/internal-error'),
      failed('messaging/server-unavailable'),
    ]);
    await expect(
      new FcmPushSender(messaging).send(['a', 'b'], { title: 't', body: 'b' }),
    ).rejects.toThrow();
    expect(await new FcmPushSender(sent([])).send([], { title: 't', body: 'b' })).toEqual({
      gone: [],
    });
  });
  it('is simply off without a key file, or with one it cannot read', () => {
    const config = (value) => ({ get: () => value });
    expect(FcmPushSender.fromEnvironment(config(undefined))).toBeNull();
    expect(FcmPushSender.fromEnvironment(config(' '))).toBeNull();
    expect(FcmPushSender.fromEnvironment(config('/nowhere/key.json'))).toBeNull();
  });
});

describe('the push consumer', () => {
  const now = new Date('2026-10-06T12:00:00Z');
  const event = (draft, ageMs = 0) => ({
    ...draft,
    eventId: id(),
    occurredAt: new Date(now.getTime() - ageMs),
  });
  function consumer(enabled = true) {
    const push = { enabled, sendToAccount: jest.fn().mockResolvedValue({ sent: 1 }) };
    const registry = new OutboxConsumerRegistry();
    const built = new PushOutboxConsumer(registry, push, () => now);
    built.onModuleInit();
    return { built, push, registry };
  }
  it('pushes a decision to the account it is for, with what opens the right screen', async () => {
    const { built, push } = consumer();
    const [listingId, ownerId] = [id(), id()];
    await built.deliver(
      event(
        listingDecisionEvent({
          approved: true,
          listingId,
          ownerId,
          listingVersion: 3,
          occurredAt: now,
        }),
      ),
    );
    expect(push.sendToAccount).toHaveBeenCalledWith(ownerId, {
      title: 'تم نشر إعلانك',
      body: expect.any(String),
      data: { type: 'LISTING_APPROVED', targetType: 'LISTING', targetId: listingId },
    });
    const accountId = id();
    await built.deliver(
      event(kycDecisionEvent({ decision: 'rejected', accountId, kycVersion: 1, occurredAt: now })),
    );
    expect(push.sendToAccount.mock.calls.at(-1)[0]).toBe(accountId);
  });
  it('does not push old news', async () => {
    const { built, push } = consumer();
    const draft = listingDecisionEvent({
      approved: true,
      listingId: id(),
      ownerId: id(),
      listingVersion: 1,
      occurredAt: now,
    });
    await built.deliver(event(draft, STALE_AFTER_MS + 1000));
    expect(push.sendToAccount).not.toHaveBeenCalled();
    await built.deliver(event(draft, STALE_AFTER_MS - 1000));
    expect(push.sendToAccount).toHaveBeenCalledTimes(1);
  });
  it('lets a failed push be tried again', async () => {
    const { built, push } = consumer();
    push.sendToAccount.mockRejectedValueOnce(new Error('unreachable'));
    const draft = listingDecisionEvent({
      approved: false,
      listingId: id(),
      ownerId: id(),
      listingVersion: 1,
      occurredAt: now,
    });
    await expect(built.deliver(event(draft))).rejects.toThrow('unreachable');
  });
  it('takes its place beside the inbox only when pushes can be sent', () => {
    expect(
      consumer(true)
        .registry.list()
        .map((item) => item.name),
    ).toEqual(['push']);
    expect(consumer(false).registry.list()).toEqual([]);
  });
});

describe('device registration over HTTP', () => {
  let app;
  let context;
  const user = { userId: id(), systemRole: 'USER', accountStatus: 'ACTIVE' };
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    context = setup();
    app = httpApp(
      { PushService: context.service, NotificationsService: {} },
      (target, provided) =>
        target.use(
          '/api/v1/notifications',
          require('../src/routes/notifications.routes').createRouter(provided),
        ),
      async (req) => {
        req.user = user;
      },
    );
    await app.init();
  });
  afterAll(async () => app.close());

  it('registers with a sign-in and unregisters with the token alone', async () => {
    const body = { token: token('http'), platform: 'android' };
    await api().put('/api/v1/notifications/devices').send(body).expect(401);
    await api()
      .put('/api/v1/notifications/devices')
      .set('Authorization', 'Bearer user')
      .send(body)
      .expect(200);
    expect(context.devices.docs).toHaveLength(1);
    await api().delete('/api/v1/notifications/devices').send({ token: 'nope' }).expect(400);
    await api().delete('/api/v1/notifications/devices').send({ token: body.token }).expect(200);
    expect(context.devices.docs).toHaveLength(0);
  });
});
