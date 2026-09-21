import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

// Client-supplied correlation ids are echoed in headers and logs, so only a
// conservative character set is accepted; anything else is replaced.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

const storage = new AsyncLocalStorage<{ requestId: string }>();

export function resolveRequestId(supplied: unknown): string {
  const value = Array.isArray(supplied) ? supplied[0] : supplied;
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : randomUUID();
}

export function getRequestId(request: unknown): string | undefined {
  const value = (request as { requestId?: unknown } | undefined)?.requestId;
  return typeof value === 'string' && value ? value : undefined;
}

/** The id of the HTTP request currently being handled, if any. */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function requestIdMiddleware(request: Request, response: Response, next: NextFunction): void {
  const requestId = resolveRequestId(request.headers['x-request-id']);
  (request as Request & { requestId?: string }).requestId = requestId;
  response.setHeader('X-Request-Id', requestId);
  storage.run({ requestId }, next);
}
