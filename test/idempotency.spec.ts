import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import {
  IdempotencyErrorCode,
  IdempotencyService,
  canonicalize,
} from '../src/common/idempotency/idempotency.service';
import { PropertiesController } from '../src/properties/properties.controller';
import { PropertiesService } from '../src/properties/properties.service';

/** In-memory stand-in for the idempotency collection, including its unique index. */
function fakeRecords() {
  const rows: any[] = [];
  const same = (row: any, filter: any) =>
    ['accountId', 'scope', 'keyHash'].every((field) => String(row[field]) === String(filter[field]));
  const model = {
    rows,
    create: jest.fn(async (doc: any) => {
      if (rows.some((row) => same(row, doc))) throw Object.assign(new Error('duplicate key'), { code: 11000 });
      rows.push({ ...doc });
    }),
    findOne: jest.fn((filter: any) => ({ lean: () => ({ exec: async () => rows.find((row) => same(row, filter)) ?? null }) })),
    findOneAndUpdate: jest.fn((filter: any, update: any) => ({
      lean: () => ({
        exec: async () => {
          const row = rows.find((candidate) =>
            same(candidate, filter) && candidate.status === filter.status && candidate.leaseExpiresAt <= filter.leaseExpiresAt.$lte);
          if (!row) return null;
          Object.assign(row, update.$set);
          return row;
        },
      }),
    })),
    updateOne: jest.fn((filter: any, update: any) => ({
      exec: async () => {
        const row = rows.find((candidate) => same(candidate, filter));
        if (row) Object.assign(row, update.$set);
      },
    })),
    deleteOne: jest.fn((filter: any) => ({
      exec: async () => {
        const index = rows.findIndex((row) => same(row, filter) && (!filter.status || row.status === filter.status));
        if (index >= 0) rows.splice(index, 1);
      },
    })),
  };
  return model;
}

const account = new Types.ObjectId().toString();
const key = 'flutter-1234567890-abcdef';

describe('IdempotencyService', () => {
  let records: ReturnType<typeof fakeRecords>;
  let service: IdempotencyService;
  const run = (operation: () => Promise<any>, overrides: Record<string, unknown> = {}) =>
    service.execute({ scope: 'property.create', accountId: account, key, fingerprint: () => 'fp-1', ...overrides } as any, operation);

  beforeEach(() => {
    records = fakeRecords();
    service = new IdempotencyService(records as any);
  });

  it('runs an operation without a key exactly as before, touching no records', async () => {
    const operation = jest.fn().mockResolvedValue({ ok: true });
    await service.execute({ scope: 's', accountId: account, key: undefined, fingerprint: () => 'x' }, operation);
    await service.execute({ scope: 's', accountId: account, key: undefined, fingerprint: () => 'x' }, operation);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(records.create).not.toHaveBeenCalled();
  });

  it('runs once and replays the recorded result for a retry with the same key and content', async () => {
    const operation = jest.fn().mockResolvedValue({ message: 'saved', property: { id: 'p1', when: new Date('2026-01-01T00:00:00Z') } });
    const first = await run(operation);
    const second = await run(operation);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ message: 'saved', property: { id: 'p1', when: '2026-01-01T00:00:00.000Z' } });
    expect(first.property.id).toBe(second.property.id);
    expect(records.rows).toHaveLength(1);
    expect(records.rows[0].status).toBe('completed');
  });

  it('stores only a hash of the key', async () => {
    await run(jest.fn().mockResolvedValue({}));
    expect(JSON.stringify(records.rows)).not.toContain(key);
    expect(records.rows[0].keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects the same key with different content instead of replaying something else', async () => {
    await run(jest.fn().mockResolvedValue({ id: 1 }));
    const operation = jest.fn();
    await expect(run(operation, { fingerprint: () => 'fp-2' })).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: IdempotencyErrorCode.KEY_REUSED }),
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it('turns away a duplicate that arrives while the first is still running, then replays once it finishes', async () => {
    let finish!: (value: unknown) => void;
    const slow = jest.fn(() => new Promise((resolve) => { finish = resolve; }));
    const first = run(slow);
    await new Promise((resolve) => setImmediate(resolve));

    const duplicate = jest.fn();
    await expect(run(duplicate)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: IdempotencyErrorCode.IN_PROGRESS, retryAfterSeconds: 3 }),
    });
    expect(duplicate).not.toHaveBeenCalled();

    finish({ id: 'created' });
    await expect(first).resolves.toEqual({ id: 'created' });
    await expect(run(duplicate)).resolves.toEqual({ id: 'created' });
    expect(duplicate).not.toHaveBeenCalled();
  });

  it('lets the client retry after a failed attempt, and records only the success', async () => {
    const operation = jest.fn().mockRejectedValueOnce(new Error('cloudinary down')).mockResolvedValueOnce({ id: 'p2' });
    await expect(run(operation)).rejects.toThrow('cloudinary down');
    expect(records.rows).toHaveLength(0);
    await expect(run(operation)).resolves.toEqual({ id: 'p2' });
    await expect(run(operation)).resolves.toEqual({ id: 'p2' });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('takes over work whose first attempt died past its lease', async () => {
    void run(() => new Promise(() => undefined)); // never settles: the record stays in progress
    await new Promise((resolve) => setImmediate(resolve));
    expect(records.rows[0].status).toBe('in_progress');
    records.rows[0].leaseExpiresAt = new Date(Date.now() - 1_000);
    const operation = jest.fn().mockResolvedValue({ id: 'recovered' });
    await expect(run(operation)).resolves.toEqual({ id: 'recovered' });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it.each(['short', 'has spaces in it!', 'a'.repeat(129), 'bad/slash/key1', '<script>alert(1)</script>'])(
    'rejects the malformed key %j',
    async (bad) => {
      const operation = jest.fn();
      await expect(run(operation, { key: bad })).rejects.toMatchObject({
        status: 400,
        response: expect.objectContaining({ code: IdempotencyErrorCode.KEY_INVALID }),
      });
      expect(operation).not.toHaveBeenCalled();
    },
  );

  it('keeps accounts and scopes independent', async () => {
    const operation = jest.fn().mockResolvedValue({ n: 1 });
    await run(operation);
    await run(operation, { accountId: new Types.ObjectId().toString() });
    await run(operation, { scope: 'property.revision' });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('still returns the result when recording completion fails, and reports it', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    records.updateOne.mockImplementationOnce(() => ({ exec: async () => { throw new Error('db blip'); } }));
    await expect(run(jest.fn().mockResolvedValue({ id: 'ok' }))).resolves.toEqual({ id: 'ok' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('idempotency_completion_failed'));
    error.mockRestore();
  });

  it('propagates unexpected database errors from reserving the key', async () => {
    records.create.mockRejectedValueOnce(new Error('connection lost'));
    await expect(run(jest.fn())).rejects.toThrow('connection lost');
  });
});

describe('canonicalize', () => {
  it('ignores key order and undefined values but respects array order', () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: [1, 2] } })).toBe(canonicalize({ a: { c: [1, 2], d: 2 }, b: 1, z: undefined }));
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it('distinguishes different values and types', () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: '1' }));
    expect(canonicalize({ a: null })).toBe('{"a":null}');
  });

  it('handles class instances such as validated DTOs', () => {
    class Dto { title = 't'; area = 90; }
    expect(canonicalize(new Dto())).toBe(canonicalize({ area: 90, title: 't' }));
  });
});

describe('property create/revision idempotency', () => {
  const dto: any = { title: 'شقة', area: 90, latitude: 30.05, longitude: 31.24 };
  const image = (bytes: number) => ({ fieldname: 'images', mimetype: 'image/jpeg', buffer: Buffer.alloc(8, bytes) }) as Express.Multer.File;
  const created = { message: 'تم حفظ مسودة العقار بنجاح', property: { id: 'p1', status: 'draft', revisionId: 'r1', revisionVersion: 0 } };

  function build() {
    const records = fakeRecords();
    const idempotency = new IdempotencyService(records as any);
    const service: any = new (PropertiesService as any)(
      {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, { assertUnlocked: jest.fn() }, idempotency,
    );
    jest.spyOn(service, 'resolveAdvertiser').mockResolvedValue({ actorId: new Types.ObjectId(account), advertiserId: new Types.ObjectId(account), accountType: 'USER' });
    const createWithAttribution = jest.spyOn(service, 'createWithAttribution').mockResolvedValue(created);
    return { service, createWithAttribution, records };
  }

  it('creates one draft when a timed-out client retries with the same key', async () => {
    const { service, createWithAttribution } = build();
    const files = { images: [image(1), image(2)] };
    const first = await service.createSelf(account, dto, files, '1.1.1.1', key);
    const retry = await service.createSelf(account, { ...dto }, { images: [image(1), image(2)] }, '1.1.1.1', key);

    expect(createWithAttribution).toHaveBeenCalledTimes(1);
    expect(retry).toEqual(first);
  });

  it('does not dedupe without a key, so existing clients behave as before', async () => {
    const { service, createWithAttribution } = build();
    await service.createSelf(account, dto, { images: [image(1)] }, '1.1.1.1');
    await service.createSelf(account, dto, { images: [image(1)] }, '1.1.1.1');
    expect(createWithAttribution).toHaveBeenCalledTimes(2);
  });

  it('rejects a reused key when the form or a photo changed', async () => {
    const { service } = build();
    await service.createSelf(account, dto, { images: [image(1)] }, '1.1.1.1', key);
    await expect(service.createSelf(account, { ...dto, title: 'other' }, { images: [image(1)] }, '1.1.1.1', key))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: IdempotencyErrorCode.KEY_REUSED }) });
    await expect(service.createSelf(account, dto, { images: [image(9)] }, '1.1.1.1', key))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: IdempotencyErrorCode.KEY_REUSED }) });
    await expect(service.createSelf(account, dto, { images: [image(1), image(1)] }, '1.1.1.1', key))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: IdempotencyErrorCode.KEY_REUSED }) });
  });

  it('lets the client retry after the first attempt failed', async () => {
    const { service, createWithAttribution } = build();
    createWithAttribution.mockRejectedValueOnce(new Error('upload failed')).mockResolvedValueOnce(created);
    await expect(service.createSelf(account, dto, { images: [image(1)] }, '1.1.1.1', key)).rejects.toThrow('upload failed');
    await expect(service.createSelf(account, dto, { images: [image(1)] }, '1.1.1.1', key)).resolves.toEqual(created);
  });

  it('applies the same protection to saving a revision, scoped to that property', async () => {
    const { service } = build();
    const once = jest.spyOn(service, 'createDraftRevisionOnce').mockResolvedValue(created);
    const propertyId = new Types.ObjectId().toString();
    const other = new Types.ObjectId().toString();

    await service.createDraftRevision(account, propertyId, dto, { images: [image(1)] }, '1.1.1.1', key);
    await service.createDraftRevision(account, propertyId, dto, { images: [image(1)] }, '1.1.1.1', key);
    expect(once).toHaveBeenCalledTimes(1);

    await expect(service.createDraftRevision(account, other, dto, { images: [image(1)] }, '1.1.1.1', key))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: IdempotencyErrorCode.KEY_REUSED }) });
  });

  it('lets a retried submit-for-review replay its success instead of failing with a version conflict', async () => {
    const { service } = build();
    const once = jest.spyOn(service, 'submitRevisionOnce').mockResolvedValue({ message: 'تم إرسال العقار للمراجعة بنجاح', revision: { id: 'r1' } });
    const propertyId = new Types.ObjectId().toString();
    const revisionId = new Types.ObjectId().toString();

    const first = await service.submitRevision(account, propertyId, revisionId, 0, '1.1.1.1', key);
    const retry = await service.submitRevision(account, propertyId, revisionId, 0, '1.1.1.1', key);
    expect(retry).toEqual(first);
    expect(once).toHaveBeenCalledTimes(1);

    await expect(service.submitRevision(account, propertyId, revisionId, 5, '1.1.1.1', key))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: IdempotencyErrorCode.KEY_REUSED }) });
  });

  it('shares one client key across create and submit because their scopes differ', async () => {
    const { service } = build();
    jest.spyOn(service, 'submitRevisionOnce').mockResolvedValue({ message: 'ok', revision: {} });
    await service.createSelf(account, dto, { images: [image(1)] }, '1.1.1.1', key);
    await expect(service.submitRevision(account, new Types.ObjectId().toString(), new Types.ObjectId().toString(), 0, '1.1.1.1', key)).resolves.toBeDefined();
  });

  it('is optional infrastructure: the service still works when it is not provided', async () => {
    const service: any = new (PropertiesService as any)({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, { assertUnlocked: jest.fn() });
    jest.spyOn(service, 'resolveAdvertiser').mockResolvedValue({});
    jest.spyOn(service, 'createWithAttribution').mockResolvedValue(created);
    await expect(service.createSelf(account, dto, {}, '1.1.1.1', key)).resolves.toEqual(created);
  });

  it('is passed through from the Idempotency-Key header by the controller', async () => {
    const service = { createSelf: jest.fn().mockResolvedValue(created), createDraftRevision: jest.fn().mockResolvedValue(created) };
    const controller = new PropertiesController(service as any);
    (service as any).submitRevision = jest.fn().mockResolvedValue(created);
    const req = { user: { userId: account }, ip: '2.2.2.2' };

    await controller.create(req, dto, {}, key);
    expect(service.createSelf).toHaveBeenCalledWith(account, dto, {}, '2.2.2.2', key);
    await controller.createRevision(req, 'p1', dto, {}, key);
    expect(service.createDraftRevision).toHaveBeenCalledWith(account, 'p1', dto, {}, '2.2.2.2', key);
    await controller.submitRevision(req, 'p1', { revisionId: 'r1', version: 0 } as any, key);
    expect((service as any).submitRevision).toHaveBeenCalledWith(account, 'p1', 'r1', 0, '2.2.2.2', key);
  });
});
