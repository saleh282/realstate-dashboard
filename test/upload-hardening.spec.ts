import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { BadRequestException, Controller, INestApplication, Post, UploadedFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/app.setup';
import { BoundedFile, BoundedFileFields } from '../src/common/uploads/bounded-upload.interceptor';
import {
  MULTIPART_OVERHEAD_BYTES,
  UploadBudget,
  resetUploadBudgetForTests,
  uploadLimitsFromEnv,
} from '../src/common/uploads/upload-budget';

const MAX_REQUEST = 1_000_000;
const PER_FILE = 600_000;
const allowed = new Set(['image/png', 'image/jpeg']);
const fileFilter = (_req: any, file: Express.Multer.File, cb: any) =>
  allowed.has(file.mimetype)
    ? cb(null, true)
    : cb(new BadRequestException({ message: 'unsupported', code: 'EVIDENCE_FILE_TYPE_UNSUPPORTED' }), false);

@Controller('upload')
class UploadProbeController {
  @Post('many')
  @UseInterceptors(BoundedFileFields([{ name: 'images', maxCount: 3 }], {
    maxRequestBytes: MAX_REQUEST,
    multer: { limits: { fileSize: PER_FILE, files: 3 }, fileFilter },
  }))
  many(@UploadedFiles() files: { images?: Express.Multer.File[] }) {
    const images = files?.images ?? [];
    return { count: images.length, bytes: images.reduce((sum, file) => sum + file.buffer.length, 0), sizesMatch: images.every((file) => file.size === file.buffer.length) };
  }

  @Post('one')
  @UseInterceptors(BoundedFile('image', { maxRequestBytes: 300_000, multer: { limits: { fileSize: 200_000, files: 1 }, fileFilter } }))
  one(@UploadedFile() image?: Express.Multer.File) {
    return { bytes: image?.buffer.length ?? 0 };
  }
}

const BOUNDARY = '----mazadtestboundary';
const partHeader = (name: string, filename: string, type = 'image/png') =>
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`;
const closing = `\r\n--${BOUNDARY}--\r\n`;

function multipartBody(files: Array<{ field?: string; size: number; type?: string }>): Buffer {
  const chunks: Buffer[] = [];
  files.forEach((file, index) => {
    chunks.push(Buffer.from(partHeader(file.field ?? 'images', `f${index}.png`, file.type)));
    chunks.push(Buffer.alloc(file.size, 0x61));
    chunks.push(Buffer.from('\r\n'));
  });
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

const asUser = (user: string) => ({ 'x-test-user': user });

describe('bounded upload handling', () => {
  let app: NestExpressApplication;
  let port: number;
  let budget: UploadBudget;
  const open: http.ClientRequest[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [UploadProbeController] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.use((req: any, _res: any, next: () => void) => {
      const user = req.headers['x-test-user'];
      if (user) req.user = { userId: String(user) };
      next();
    });
    configureApp(app, { NODE_ENV: 'test' } as any);
    await app.listen(0);
    port = (app.getHttpServer().address() as any).port;
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    budget = resetUploadBudgetForTests({ maxInFlightBytes: 800_000, maxConcurrentPerUser: 2 });
  });
  afterEach(async () => {
    open.splice(0).forEach((req) => req.destroy());
    await settled();
  });

  const settled = async (timeoutMs = 3_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (budget.bufferedBytes === 0 && ['u1', 'u2', 'u3'].every((user) => budget.activeFor(`user:${user}`) === 0)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`budget did not settle: ${budget.bufferedBytes} bytes buffered`);
  };
  const waitUntil = async (predicate: () => boolean, timeoutMs = 3_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('condition not reached');
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  };

  /** Raw POST that reports the response even when the server closes before the body is fully sent. */
  const rawPost = (headers: Record<string, string | number>, body: Buffer) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      let responded = false;
      const req = http.request({ port, method: 'POST', path: '/api/v1/upload/many', headers }, (res) => {
        responded = true;
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text || '{}') }));
      });
      req.on('error', (error) => { if (!responded) reject(error); });
      req.end(body);
    });

  /** Starts an upload and leaves it half-sent so it keeps its slot and buffered bytes. */
  function startStalledUpload(user: string, bufferedFileBytes: number) {
    const req = http.request({
      port, method: 'POST', path: '/api/v1/upload/many',
      headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`, 'Transfer-Encoding': 'chunked', 'x-test-user': user },
    });
    req.on('error', () => undefined);
    req.write(partHeader('images', 'stalled.png'));
    req.write(Buffer.alloc(bufferedFileBytes, 0x61));
    open.push(req);
    return req;
  }

  it('still accepts a normal authenticated upload and returns the buffers untouched', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/upload/many')
      .set(asUser('u1'))
      .attach('images', Buffer.alloc(100_000, 1), { filename: 'a.png', contentType: 'image/png' })
      .attach('images', Buffer.alloc(50_000, 2), { filename: 'b.jpg', contentType: 'image/jpeg' })
      .expect(201);
    expect(res.body.data).toEqual({ count: 2, bytes: 150_000, sizesMatch: true });
    await settled();
  });

  it('rejects an oversized request from its declared length before reading the body', async () => {
    const body = Buffer.alloc(MAX_REQUEST + MULTIPART_OVERHEAD_BYTES + 10, 0x61);
    const result = await rawPost(
      { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`, 'Content-Length': body.length, ...asUser('u1') },
      body,
    );
    expect(result.status).toBe(413);
    expect(result.body).toMatchObject({ success: false, code: 'UPLOAD_REQUEST_TOO_LARGE' });
    expect(budget.bufferedBytes).toBe(0);
    await settled();
  });

  it('enforces the request ceiling while streaming when no length is declared', async () => {
    budget = resetUploadBudgetForTests({ maxInFlightBytes: 10_000_000, maxConcurrentPerUser: 2 });
    const result = await rawPost(
      { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`, 'Transfer-Encoding': 'chunked', ...asUser('u1') },
      multipartBody([{ size: 500_000 }, { size: 500_000 }, { size: 500_000 }]),
    );
    expect(result.status).toBe(413);
    expect(result.body).toMatchObject({ code: 'UPLOAD_REQUEST_TOO_LARGE' });
    await settled();
    expect(budget.bufferedBytes).toBe(0);
  });

  it('keeps enforcing per-file size and type rules, and frees memory after rejecting them', async () => {
    const tooBig = await request(app.getHttpServer())
      .post('/api/v1/upload/many')
      .set(asUser('u1'))
      .attach('images', Buffer.alloc(PER_FILE + 1000, 1), { filename: 'big.png', contentType: 'image/png' });
    expect(tooBig.status).toBe(413);

    const wrongType = await request(app.getHttpServer())
      .post('/api/v1/upload/many')
      .set(asUser('u1'))
      .attach('images', Buffer.from('%PDF-1.4'), { filename: 'x.pdf', contentType: 'application/pdf' })
      .expect(400);
    expect(wrongType.body).toMatchObject({ code: 'EVIDENCE_FILE_TYPE_UNSUPPORTED' });
    await settled();
  });

  it('bounds non-file form fields too', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/upload/many')
      .set(asUser('u1'))
      .field('notes', 'x'.repeat(300 * 1024));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('applies the same protections to single-file endpoints', async () => {
    await request(app.getHttpServer()).post('/api/v1/upload/one').set(asUser('u1'))
      .attach('image', Buffer.alloc(1000, 1), { filename: 'a.png', contentType: 'image/png' }).expect(201);
    const body = Buffer.alloc(300_000 + MULTIPART_OVERHEAD_BYTES + 1, 0x61);
    const oversized = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      let responded = false;
      const req = http.request({
        port, method: 'POST', path: '/api/v1/upload/one',
        headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`, 'Content-Length': body.length, ...asUser('u1') },
      }, (res) => {
        responded = true;
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text || '{}') }));
      });
      req.on('error', (error) => { if (!responded) reject(error); });
      req.end(body);
    });
    expect(oversized.status).toBe(413);
    expect(oversized.body.code).toBe('UPLOAD_REQUEST_TOO_LARGE');
    await settled();
  });

  it('caps how many uploads one account can hold open, without affecting other accounts', async () => {
    startStalledUpload('u1', 1000);
    startStalledUpload('u1', 1000);
    await waitUntil(() => budget.activeFor('user:u1') === 2);

    const third = await request(app.getHttpServer())
      .post('/api/v1/upload/many')
      .set(asUser('u1'))
      .attach('images', Buffer.alloc(1000, 1), { filename: 'a.png', contentType: 'image/png' })
      .expect(429);
    expect(third.body).toMatchObject({ code: 'UPLOAD_CONCURRENCY_LIMIT', retryAfterSeconds: 5 });

    await request(app.getHttpServer())
      .post('/api/v1/upload/many')
      .set(asUser('u2'))
      .attach('images', Buffer.alloc(1000, 1), { filename: 'a.png', contentType: 'image/png' })
      .expect(201);

    open.splice(0).forEach((req) => req.destroy());
    await settled();
    await request(app.getHttpServer())
      .post('/api/v1/upload/many')
      .set(asUser('u1'))
      .attach('images', Buffer.alloc(1000, 1), { filename: 'a.png', contentType: 'image/png' })
      .expect(201);
  });

  it('protects total memory across accounts and recovers once pressure clears', async () => {
    startStalledUpload('u1', 500_000);
    await waitUntil(() => budget.bufferedBytes >= 500_000);

    const rejected = await request(app.getHttpServer())
      .post('/api/v1/upload/many')
      .set(asUser('u2'))
      .attach('images', Buffer.alloc(500_000, 1), { filename: 'a.png', contentType: 'image/png' })
      .expect(503);
    expect(rejected.body).toMatchObject({ code: 'UPLOAD_CAPACITY_EXCEEDED', retryAfterSeconds: 5 });
    expect(budget.bufferedBytes).toBeLessThanOrEqual(800_000);

    open.splice(0).forEach((req) => req.destroy());
    await settled();
    await request(app.getHttpServer())
      .post('/api/v1/upload/many')
      .set(asUser('u2'))
      .attach('images', Buffer.alloc(500_000, 1), { filename: 'a.png', contentType: 'image/png' })
      .expect(201);
  });

  it('releases the slot and memory when the client disconnects mid-upload', async () => {
    const req = startStalledUpload('u3', 300_000);
    await waitUntil(() => budget.activeFor('user:u3') === 1 && budget.bufferedBytes >= 300_000);
    req.destroy();
    await settled();
    expect(budget.activeFor('user:u3')).toBe(0);
  });
});

describe('UploadBudget', () => {
  it('rejects requests over the per-account concurrency and releases slots exactly once', () => {
    const budget = new UploadBudget({ maxInFlightBytes: 1000, maxConcurrentPerUser: 1 });
    const first = budget.admit({ userKey: 'a', maxRequestBytes: 500 });
    expect(() => budget.admit({ userKey: 'a', maxRequestBytes: 500 })).toThrow(expect.objectContaining({ status: 429 }));
    expect(budget.admit({ userKey: 'b', maxRequestBytes: 500 })).toBeDefined();
    first.release();
    first.release();
    expect(budget.activeFor('a')).toBe(0);
    expect(budget.admit({ userKey: 'a', maxRequestBytes: 500 })).toBeDefined();
  });

  it('enforces the per-request and process-wide byte ceilings and returns bytes on release', () => {
    const budget = new UploadBudget({ maxInFlightBytes: 600, maxConcurrentPerUser: 5 });
    const one = budget.admit({ userKey: 'a', maxRequestBytes: 500 });
    one.reserve(400);
    expect(() => one.reserve(200)).toThrow(expect.objectContaining({ status: 413 }));
    const two = budget.admit({ userKey: 'b', maxRequestBytes: 500 });
    expect(() => two.reserve(300)).toThrow(expect.objectContaining({ status: 503 }));
    expect(budget.bufferedBytes).toBe(400);
    one.release();
    expect(budget.bufferedBytes).toBe(0);
    two.reserve(300);
    expect(budget.bufferedBytes).toBe(300);
  });

  it('never leaks accounting after a ticket is released', () => {
    const budget = new UploadBudget({ maxInFlightBytes: 1000, maxConcurrentPerUser: 2 });
    const ticket = budget.admit({ userKey: 'a', maxRequestBytes: 900 });
    ticket.reserve(300);
    ticket.unreserve(100);
    expect(budget.bufferedBytes).toBe(200);
    ticket.release();
    ticket.reserve(500);
    ticket.unreserve(500);
    expect(budget.bufferedBytes).toBe(0);
  });

  it('reads limits from the environment and ignores invalid values', () => {
    expect(uploadLimitsFromEnv({ UPLOAD_MAX_INFLIGHT_BYTES: '1048576', UPLOAD_MAX_CONCURRENT_PER_USER: '4' } as any))
      .toEqual({ maxInFlightBytes: 1048576, maxConcurrentPerUser: 4 });
    expect(uploadLimitsFromEnv({ UPLOAD_MAX_INFLIGHT_BYTES: '-1', UPLOAD_MAX_CONCURRENT_PER_USER: 'x' } as any))
      .toEqual({ maxInFlightBytes: 256 * 1024 * 1024, maxConcurrentPerUser: 2 });
  });
});

describe('upload endpoint regression guard', () => {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);

  it('never uses the unbounded multer interceptors outside the shared wrapper', () => {
    const offenders = walk(path.join(__dirname, '../src'))
      .filter((file) => file.endsWith('.ts') && !file.includes(`${path.sep}common${path.sep}uploads${path.sep}`))
      .filter((file) => /\b(FileInterceptor|FileFieldsInterceptor|FilesInterceptor|AnyFilesInterceptor|NoFilesInterceptor)\b/.test(fs.readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
