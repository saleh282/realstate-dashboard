'use strict';

const { Logger } = require('../common/logging/logger');
const DEFAULT_PING_TIMEOUT_MS = 2_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;
const PRODUCTION_DRAIN_MS = 5_000;
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
/**
 * Liveness only proves the process can answer. Readiness reflects whether this
 * instance should receive traffic: it needs its database, and it stops being
 * ready as soon as shutdown begins so a load balancer drains it first.
 */
class HealthService {
  constructor(connection, config) {
    this.connection = connection;
    this.config = config;
    this.logger = new Logger(HealthService.name);
    this.shuttingDown = false;
  }
  get isShuttingDown() {
    return this.shuttingDown;
  }
  liveness() {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }
  async readiness() {
    if (this.shuttingDown) return { ready: false, checks: { shutdown: 'draining' } };
    const mongo = await this.pingDatabase();
    return { ready: mongo, checks: { mongo: mongo ? 'up' : 'down' } };
  }
  async beforeApplicationShutdown(signal) {
    this.shuttingDown = true;
    this.logger.warn(`Shutdown requested${signal ? ` (${signal})` : ''}; readiness is now failing`);
    const timeoutMs = this.numberSetting('SHUTDOWN_TIMEOUT_MS', DEFAULT_SHUTDOWN_TIMEOUT_MS);
    // Backstop: if draining or closing connections hangs, do not stay half-alive.
    setTimeout(() => {
      this.logger.error(`Graceful shutdown exceeded ${timeoutMs}ms; forcing exit`);
      process.exit(1);
    }, timeoutMs).unref();
    const defaultDrain = this.config.get('NODE_ENV') === 'production' ? PRODUCTION_DRAIN_MS : 0;
    const drainMs = this.numberSetting('SHUTDOWN_DRAIN_MS', defaultDrain);
    if (drainMs > 0) await new Promise((resolve) => setTimeout(resolve, drainMs));
  }
  async pingDatabase() {
    try {
      if (this.connection.readyState !== 1 || !this.connection.db) return false;
      await withTimeout(this.connection.db.admin().ping(), DEFAULT_PING_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    }
  }
  numberSetting(key, fallback) {
    const raw = this.config.get(key);
    const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }
}

Object.assign(exports, { HealthService });
