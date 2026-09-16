import { BadRequestException } from '@nestjs/common';
import { EvidenceErrorCode } from '../src/common/errors/evidence-error-codes';
import { validateEvidenceFile } from '../src/common/uploads/evidence-file.validator';

const png = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000000000000000000049454e4400000000',
  'hex',
);

function file(buffer: Buffer, mimetype = 'image/png'): Express.Multer.File {
  return { buffer, mimetype, originalname: '../../unsafe.png' } as Express.Multer.File;
}

function codeOf(error: unknown) {
  return (error as BadRequestException).getResponse() as { code: string };
}

describe('private evidence file validation', () => {
  const policy = { kind: 'document' as const, maxBytes: 1024, maxImagePixels: 10, allowPdf: true };

  it('accepts a structurally valid allowed image without trusting its filename', () => {
    expect(validateEvidenceFile(file(png), policy)).toMatchObject({ mime: 'image/png', width: 1, height: 1 });
  });

  it('rejects invalid magic bytes and MIME spoofing deterministically', () => {
    for (const candidate of [file(Buffer.from('not-an-image')), file(png, 'image/jpeg')]) {
      try { validateEvidenceFile(candidate, policy); fail('expected rejection'); }
      catch (error) { expect(codeOf(error).code).toBe(EvidenceErrorCode.FILE_INVALID); }
    }
  });

  it('rejects unsupported types', () => {
    try { validateEvidenceFile(file(Buffer.from('text'), 'text/plain'), policy); fail('expected rejection'); }
    catch (error) { expect(codeOf(error).code).toBe(EvidenceErrorCode.FILE_TYPE_UNSUPPORTED); }
  });

  it('rejects oversized and corrupt evidence', () => {
    try { validateEvidenceFile(file(Buffer.alloc(1025)), policy); fail('expected rejection'); }
    catch (error) { expect(codeOf(error).code).toBe(EvidenceErrorCode.FILE_TOO_LARGE); }
    try { validateEvidenceFile(file(Buffer.from('%PDF-1.7 without eof'), 'application/pdf'), policy); fail('expected rejection'); }
    catch (error) { expect(codeOf(error).code).toBe(EvidenceErrorCode.FILE_INVALID); }
  });
});
