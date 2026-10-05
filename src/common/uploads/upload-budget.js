'use strict';

const { HttpException, HttpStatus } = require('../http/errors');
const { EvidenceErrorCode } = require('../errors/evidence-error-codes');
const DEFAULT_UPLOAD_LIMITS = {
  maxInFlightBytes: 256 * 1024 * 1024,
  maxConcurrentPerUser: 2,
};
// Multipart framing and text fields add a little to the file bytes.
const MULTIPART_OVERHEAD_BYTES = 256 * 1024;
const RETRY_AFTER_SECONDS = 5;
function positiveInt(raw, fallback) {
  const parsed = raw && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function uploadLimitsFromEnv(env = process.env) {
  return {
    maxInFlightBytes: positiveInt(
      env.UPLOAD_MAX_INFLIGHT_BYTES,
      DEFAULT_UPLOAD_LIMITS.maxInFlightBytes,
    ),
    maxConcurrentPerUser: positiveInt(
      env.UPLOAD_MAX_CONCURRENT_PER_USER,
      DEFAULT_UPLOAD_LIMITS.maxConcurrentPerUser,
    ),
  };
}
function rejection(status, message, code, retryAfterSeconds) {
  return new HttpException(
    { message, code, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) },
    status,
  );
}
class UploadTicket {
  constructor(budget, userKey, maxRequestBytes) {
    this.budget = budget;
    this.userKey = userKey;
    this.maxRequestBytes = maxRequestBytes;
    this.reserved = 0;
    this.released = false;
  }
  /** Accounts for bytes about to be held in memory; throws once a limit is hit. */
  reserve(bytes) {
    if (this.released) return;
    if (this.reserved + bytes > this.maxRequestBytes) {
      throw rejection(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'حجم الملفات المرفوعة يتجاوز الحد المسموح للطلب',
        EvidenceErrorCode.UPLOAD_REQUEST_TOO_LARGE,
      );
    }
    this.budget.reserveBytes(bytes);
    this.reserved += bytes;
  }
  unreserve(bytes) {
    if (this.released) return;
    const amount = Math.min(bytes, this.reserved);
    this.reserved -= amount;
    this.budget.releaseBytes(amount);
  }
  release() {
    if (this.released) return;
    this.released = true;
    this.budget.releaseBytes(this.reserved);
    this.reserved = 0;
    this.budget.releaseSlot(this.userKey);
  }
}
/**
 * Process-wide accounting for multipart uploads that are buffered in memory.
 * It bounds (a) how many upload requests one account can hold open, (b) how
 * large a single request may grow, and (c) total buffered bytes, so neither one
 * account nor a burst of accounts can exhaust the server's memory.
 */
class UploadBudget {
  constructor(limits = DEFAULT_UPLOAD_LIMITS) {
    this.limits = limits;
    this.activeByUser = new Map();
    this.inFlightBytes = 0;
  }
  get bufferedBytes() {
    return this.inFlightBytes;
  }
  activeFor(userKey) {
    return this.activeByUser.get(userKey) ?? 0;
  }
  admit(options) {
    const { userKey, maxRequestBytes, declaredContentLength } = options;
    if (
      declaredContentLength !== undefined &&
      Number.isFinite(declaredContentLength) &&
      declaredContentLength > maxRequestBytes + MULTIPART_OVERHEAD_BYTES
    ) {
      throw rejection(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'حجم الملفات المرفوعة يتجاوز الحد المسموح للطلب',
        EvidenceErrorCode.UPLOAD_REQUEST_TOO_LARGE,
      );
    }
    if (this.activeFor(userKey) >= this.limits.maxConcurrentPerUser) {
      throw rejection(
        HttpStatus.TOO_MANY_REQUESTS,
        'لديك عمليات رفع جارية بالفعل، انتظر حتى تكتمل ثم حاول مرة أخرى',
        EvidenceErrorCode.UPLOAD_CONCURRENCY_LIMIT,
        RETRY_AFTER_SECONDS,
      );
    }
    this.activeByUser.set(userKey, this.activeFor(userKey) + 1);
    return new UploadTicket(this, userKey, maxRequestBytes);
  }
  reserveBytes(bytes) {
    if (this.inFlightBytes + bytes > this.limits.maxInFlightBytes) {
      throw rejection(
        HttpStatus.SERVICE_UNAVAILABLE,
        'الخادم مشغول بعمليات رفع أخرى، حاول مرة أخرى بعد قليل',
        EvidenceErrorCode.UPLOAD_CAPACITY_EXCEEDED,
        RETRY_AFTER_SECONDS,
      );
    }
    this.inFlightBytes += bytes;
  }
  releaseBytes(bytes) {
    this.inFlightBytes = Math.max(0, this.inFlightBytes - bytes);
  }
  releaseSlot(userKey) {
    const remaining = this.activeFor(userKey) - 1;
    if (remaining > 0) this.activeByUser.set(userKey, remaining);
    else this.activeByUser.delete(userKey);
  }
}
let sharedBudget;
function getUploadBudget() {
  sharedBudget ??= new UploadBudget(uploadLimitsFromEnv());
  return sharedBudget;
}
function resetUploadBudgetForTests(limits) {
  sharedBudget = new UploadBudget(limits ?? uploadLimitsFromEnv());
  return sharedBudget;
}

Object.assign(exports, {
  DEFAULT_UPLOAD_LIMITS,
  MULTIPART_OVERHEAD_BYTES,
  uploadLimitsFromEnv,
  UploadTicket,
  UploadBudget,
  getUploadBudget,
  resetUploadBudgetForTests,
});
