import { HttpException, HttpStatus } from '@nestjs/common';
import { EvidenceErrorCode } from '../errors/evidence-error-codes';

export type UploadLimits = {
  /** Bytes buffered in memory across all in-flight uploads in this process. */
  maxInFlightBytes: number;
  /** Simultaneous upload requests one authenticated account may have open. */
  maxConcurrentPerUser: number;
};

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxInFlightBytes: 256 * 1024 * 1024,
  maxConcurrentPerUser: 2,
};

// Multipart framing and text fields add a little to the file bytes.
export const MULTIPART_OVERHEAD_BYTES = 256 * 1024;
const RETRY_AFTER_SECONDS = 5;

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function uploadLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): UploadLimits {
  return {
    maxInFlightBytes: positiveInt(env.UPLOAD_MAX_INFLIGHT_BYTES, DEFAULT_UPLOAD_LIMITS.maxInFlightBytes),
    maxConcurrentPerUser: positiveInt(env.UPLOAD_MAX_CONCURRENT_PER_USER, DEFAULT_UPLOAD_LIMITS.maxConcurrentPerUser),
  };
}

function rejection(status: HttpStatus, message: string, code: string, retryAfterSeconds?: number) {
  return new HttpException(
    { message, code, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) },
    status,
  );
}

export class UploadTicket {
  private reserved = 0;
  private released = false;

  constructor(
    private readonly budget: UploadBudget,
    readonly userKey: string,
    readonly maxRequestBytes: number,
  ) {}

  /** Accounts for bytes about to be held in memory; throws once a limit is hit. */
  reserve(bytes: number): void {
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

  unreserve(bytes: number): void {
    if (this.released) return;
    const amount = Math.min(bytes, this.reserved);
    this.reserved -= amount;
    this.budget.releaseBytes(amount);
  }

  release(): void {
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
export class UploadBudget {
  private readonly activeByUser = new Map<string, number>();
  private inFlightBytes = 0;

  constructor(private readonly limits: UploadLimits = DEFAULT_UPLOAD_LIMITS) {}

  get bufferedBytes(): number {
    return this.inFlightBytes;
  }

  activeFor(userKey: string): number {
    return this.activeByUser.get(userKey) ?? 0;
  }

  admit(options: {
    userKey: string;
    maxRequestBytes: number;
    declaredContentLength?: number;
  }): UploadTicket {
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

  reserveBytes(bytes: number): void {
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

  releaseBytes(bytes: number): void {
    this.inFlightBytes = Math.max(0, this.inFlightBytes - bytes);
  }

  releaseSlot(userKey: string): void {
    const remaining = this.activeFor(userKey) - 1;
    if (remaining > 0) this.activeByUser.set(userKey, remaining);
    else this.activeByUser.delete(userKey);
  }
}

let sharedBudget: UploadBudget | undefined;

export function getUploadBudget(): UploadBudget {
  sharedBudget ??= new UploadBudget(uploadLimitsFromEnv());
  return sharedBudget;
}

export function resetUploadBudgetForTests(limits?: UploadLimits): UploadBudget {
  sharedBudget = new UploadBudget(limits ?? uploadLimitsFromEnv());
  return sharedBudget;
}
