'use strict';

const {
  CloudinaryAssetService,
  cleanupBackoffMs,
} = require('../src/services/cloudinary-asset.service');
const { EvidenceCleanupWorker } = require('../src/services/evidence-cleanup.worker');
const asset = {
  publicId: 'real-estate-auction/private/kyc/id-front/abc',
  resourceType: 'image',
  deliveryType: 'authenticated',
  classification: 'private_kyc_evidence',
};
function taskDoc(id, attempts = 0) {
  return { _id: id, attempts, toObject: () => ({ ...asset, publicId: `${asset.publicId}-${id}` }) };
}
/** A tiny in-memory stand-in for the tasks collection that honours claims. */
function taskStore(tasks) {
  const updates = [];
  const model = {
    findOneAndUpdate: jest.fn((filter, update) => ({
      exec: async () => {
        const now = new Date();
        const due = tasks.find(
          (task) =>
            (task.status ?? 'pending') === 'pending' &&
            (!task.nextAttemptAt || task.nextAttemptAt <= now),
        );
        if (!due) return null;
        due.nextAttemptAt = update.$set.nextAttemptAt;
        return due;
      },
    })),
    updateOne: jest.fn((filter, update) => ({
      exec: async () => {
        updates.push({ filter, update });
        const task = tasks.find((candidate) => candidate._id === filter._id);
        if (task && update.$set?.status === 'completed') task.status = 'completed';
        if (task && update.$set?.nextAttemptAt) task.nextAttemptAt = update.$set.nextAttemptAt;
      },
    })),
    countDocuments: jest.fn(() => ({
      exec: async () => tasks.filter((task) => (task.status ?? 'pending') === 'pending').length,
    })),
    findOne: jest.fn(() => ({
      sort: () => ({
        select: () => ({
          lean: () => ({ exec: async () => ({ createdAt: new Date(Date.now() - 90_000) }) }),
        }),
      }),
    })),
  };
  return { model, updates, tasks };
}
describe('CloudinaryAssetService.reconcilePendingCleanup', () => {
  it('does nothing when the tasks collection is not available', async () => {
    const service = new CloudinaryAssetService({ uploader: { destroy: jest.fn() } });
    await expect(service.reconcilePendingCleanup()).resolves.toEqual({
      processed: 0,
      completed: 0,
      failed: 0,
    });
  });
  it('completes every due task and treats an already-deleted asset as success (idempotent)', async () => {
    const store = taskStore([taskDoc('a'), taskDoc('b')]);
    const destroy = jest
      .fn()
      .mockResolvedValueOnce({ result: 'ok' })
      .mockResolvedValueOnce({ result: 'not found' });
    const service = new CloudinaryAssetService({ uploader: { destroy } }, store.model);
    await expect(service.reconcilePendingCleanup()).resolves.toEqual({
      processed: 2,
      completed: 2,
      failed: 0,
    });
    // A second pass finds nothing left to do and never calls the provider again.
    await expect(service.reconcilePendingCleanup()).resolves.toEqual({
      processed: 0,
      completed: 0,
      failed: 0,
    });
    expect(destroy).toHaveBeenCalledTimes(2);
  });
  it('claims a task with a lease before deleting so a concurrent worker skips it', async () => {
    const store = taskStore([taskDoc('a')]);
    let leaseSeenDuringDelete;
    const destroy = jest.fn(async () => {
      leaseSeenDuringDelete = store.tasks[0].nextAttemptAt;
      // While deleting, a second worker asks for work and must find none.
      await expect(
        new CloudinaryAssetService(
          { uploader: { destroy: jest.fn() } },
          store.model,
        ).reconcilePendingCleanup(),
      ).resolves.toMatchObject({ processed: 0 });
      return { result: 'ok' };
    });
    const service = new CloudinaryAssetService({ uploader: { destroy } }, store.model);
    await service.reconcilePendingCleanup();
    expect(leaseSeenDuringDelete.getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
  it('backs a failing task off, records the failure, and keeps working through the rest of the batch', async () => {
    const store = taskStore([taskDoc('bad', 2), taskDoc('good')]);
    const destroy = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('secret provider detail'), { name: 'ProviderError' }),
      )
      .mockResolvedValueOnce({ result: 'ok' });
    const service = new CloudinaryAssetService({ uploader: { destroy } }, store.model);
    const before = Date.now();
    await expect(service.reconcilePendingCleanup()).resolves.toEqual({
      processed: 2,
      completed: 1,
      failed: 1,
    });
    const failure = store.updates.find((entry) => entry.filter._id === 'bad').update;
    expect(failure.$set.lastError).toBe('ProviderError');
    expect(JSON.stringify(failure)).not.toContain('secret provider detail');
    expect(failure.$inc).toEqual({ attempts: 1 });
    expect(failure.$set.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      before + cleanupBackoffMs(3),
    );
    expect(store.tasks.find((task) => task._id === 'good').status).toBe('completed');
  });
  it('bounds the batch size', async () => {
    const many = Array.from({ length: 250 }, (_, index) => taskDoc(`t${index}`));
    const store = taskStore(many);
    const service = new CloudinaryAssetService(
      { uploader: { destroy: jest.fn().mockResolvedValue({ result: 'ok' }) } },
      store.model,
    );
    await expect(service.reconcilePendingCleanup(10_000)).resolves.toMatchObject({
      processed: 100,
    });
    await expect(service.reconcilePendingCleanup(0)).resolves.toMatchObject({ processed: 1 });
  });
  it('exposes backlog figures without asset identifiers', async () => {
    const store = taskStore([taskDoc('a')]);
    const service = new CloudinaryAssetService({ uploader: { destroy: jest.fn() } }, store.model);
    const backlog = await service.cleanupBacklog();
    expect(backlog).toMatchObject({ pending: 1 });
    expect(backlog.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(89);
    expect(JSON.stringify(backlog)).not.toContain('publicId');
  });
  it('grows the retry delay exponentially up to a ceiling', () => {
    expect(cleanupBackoffMs(1)).toBe(120_000);
    expect(cleanupBackoffMs(2)).toBe(240_000);
    expect(cleanupBackoffMs(50)).toBe(6 * 60 * 60_000);
  });
});
describe('EvidenceCleanupWorker', () => {
  const config = (values = {}) => ({ get: (key) => values[key] });
  const summary = { processed: 0, completed: 0, failed: 0 };
  const backlogOk = { pending: 0, stuck: 0, oldestPendingAgeSeconds: null };
  function build(values = {}, overrides = {}) {
    const assets = {
      reconcilePendingCleanup: overrides.reconcile ?? jest.fn().mockResolvedValue(summary),
      cleanupBacklog: overrides.backlog ?? jest.fn().mockResolvedValue(backlogOk),
    };
    const worker = new EvidenceCleanupWorker(assets, config(values));
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    worker.logger = logger;
    return { worker, assets, logger };
  }
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  it('is off under test by default and on otherwise, and can be forced either way', () => {
    expect(build({ NODE_ENV: 'test' }).worker.enabled).toBe(false);
    expect(build({ NODE_ENV: 'production' }).worker.enabled).toBe(true);
    expect(build({ NODE_ENV: 'production', CLEANUP_WORKER_ENABLED: 'false' }).worker.enabled).toBe(
      false,
    );
    expect(build({ NODE_ENV: 'test', CLEANUP_WORKER_ENABLED: 'true' }).worker.enabled).toBe(true);
  });
  it('never runs two passes at once', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const reconcile = jest.fn(async () => {
      await gate;
      return summary;
    });
    const { worker } = build({}, { reconcile });
    const first = worker.runOnce();
    await expect(worker.runOnce()).resolves.toBeNull();
    expect(reconcile).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toMatchObject({ processed: 0 });
    await expect(worker.runOnce()).resolves.not.toBeNull();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
  it('makes a failed pass observable, survives it, and recovers on the next one', async () => {
    const reconcile = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('mongodb://user:pw@db down'), { name: 'MongoNetworkError' }),
      )
      .mockResolvedValue(summary);
    const { worker, logger } = build({}, { reconcile });
    await expect(worker.runOnce()).resolves.toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logger.error.mock.calls[0][0]);
    expect(logged).toMatchObject({
      event: 'evidence_cleanup_run_failed',
      consecutiveFailures: 1,
      errorName: 'MongoNetworkError',
    });
    expect(logger.error.mock.calls[0][0]).not.toContain('pw');
    await expect(worker.runOnce()).resolves.toMatchObject({ processed: 0 });
    expect(worker.lastRunAt).toBeInstanceOf(Date);
  });
  it('raises an error-level alert when tasks are stuck or the backlog is old', async () => {
    const stuck = build(
      {},
      {
        backlog: jest.fn().mockResolvedValue({ pending: 3, stuck: 1, oldestPendingAgeSeconds: 10 }),
      },
    );
    await stuck.worker.runOnce();
    expect(JSON.parse(stuck.logger.error.mock.calls[0][0])).toMatchObject({
      event: 'evidence_cleanup_backlog_alert',
      stuck: 1,
    });
    const old = build(
      { CLEANUP_ALERT_AGE_SECONDS: '600' },
      {
        backlog: jest
          .fn()
          .mockResolvedValue({ pending: 1, stuck: 0, oldestPendingAgeSeconds: 601 }),
      },
    );
    await old.worker.runOnce();
    expect(old.logger.error).toHaveBeenCalledTimes(1);
  });
  it('warns on failures, logs progress, and stays quiet when idle', async () => {
    const failures = build(
      {},
      { reconcile: jest.fn().mockResolvedValue({ processed: 2, completed: 1, failed: 1 }) },
    );
    await failures.worker.runOnce();
    expect(failures.logger.warn).toHaveBeenCalledTimes(1);
    const progress = build(
      {},
      { reconcile: jest.fn().mockResolvedValue({ processed: 2, completed: 2, failed: 0 }) },
    );
    await progress.worker.runOnce();
    expect(progress.logger.log).toHaveBeenCalledTimes(1);
    const idle = build();
    await idle.worker.runOnce();
    expect(idle.logger.log).not.toHaveBeenCalled();
    expect(idle.logger.warn).not.toHaveBeenCalled();
    expect(idle.logger.error).not.toHaveBeenCalled();
  });
  it('honours the configured batch size, capped at 100', async () => {
    const small = build({ CLEANUP_BATCH_SIZE: '7' });
    await small.worker.runOnce();
    expect(small.assets.reconcilePendingCleanup).toHaveBeenCalledWith(7);
    const huge = build({ CLEANUP_BATCH_SIZE: '9999' });
    await huge.worker.runOnce();
    expect(huge.assets.reconcilePendingCleanup).toHaveBeenCalledWith(100);
  });
  it('schedules itself on bootstrap, repeats on the interval, and stops cleanly on shutdown', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5); // first run after 15s + 7.5s of jitter
    const { worker, assets } = build({ NODE_ENV: 'production', CLEANUP_INTERVAL_SECONDS: '60' });
    worker.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(22_499);
    expect(assets.reconcilePendingCleanup).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2);
    expect(assets.reconcilePendingCleanup).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(assets.reconcilePendingCleanup).toHaveBeenCalledTimes(2);
    await worker.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(assets.reconcilePendingCleanup).toHaveBeenCalledTimes(2);
  });
  it('does not start a timer when disabled', async () => {
    jest.useFakeTimers();
    const { worker, assets, logger } = build({
      NODE_ENV: 'production',
      CLEANUP_WORKER_ENABLED: 'false',
    });
    worker.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(assets.reconcilePendingCleanup).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('disabled'));
  });
  it('waits for an in-flight pass during shutdown', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { worker } = build(
      {},
      {
        reconcile: jest.fn(async () => {
          await gate;
          return summary;
        }),
      },
    );
    const run = worker.runOnce();
    let stopped = false;
    const stopping = worker.onModuleDestroy().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    release();
    await run;
    await stopping;
    expect(stopped).toBe(true);
  });
});
describe('EvidenceCleanupWorker dependency wiring', () => {
  it('resolves inside the same provider graph as CloudinaryModule and follows Nest lifecycle hooks', async () => {
    const model = {
      findOneAndUpdate: jest.fn(() => ({ exec: async () => null })),
      countDocuments: jest.fn(() => ({ exec: async () => 0 })),
      findOne: jest.fn(() => ({
        sort: () => ({ select: () => ({ lean: () => ({ exec: async () => null }) }) }),
      })),
    };
    const assets = new CloudinaryAssetService({ uploader: { destroy: jest.fn() } }, model);
    const worker = new EvidenceCleanupWorker(assets, {
      get: (key) => (key === 'NODE_ENV' ? 'test' : undefined),
    });
    worker.onApplicationBootstrap();
    expect(worker.enabled).toBe(false);
    await expect(worker.runOnce()).resolves.toMatchObject({ processed: 0, pending: 0 });
    await worker.onModuleDestroy();
  });
});
