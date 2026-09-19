import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { BrokerApplicationsService } from '../src/broker-applications/broker-applications.service';
import { AssetClassification } from '../src/config/evidence-asset.types';

const pdfBytes = Buffer.from('%PDF-1.7\nverification\n%%EOF');

function file(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'verificationDocument',
    originalname: 'verification.pdf',
    mimetype: 'application/pdf',
    buffer: pdfBytes,
    size: pdfBytes.length,
    ...overrides,
  } as Express.Multer.File;
}

function service() {
  return new BrokerApplicationsService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('V1 broker verification document contract', () => {
  it('accepts exactly one genuine PDF', () => {
    expect((service() as any).validateVerificationDocument([file()])).toMatchObject({
      fieldname: 'verificationDocument',
      mimetype: 'application/pdf',
    });
  });

  it('rejects a missing file', () => {
    expect(() => (service() as any).validateVerificationDocument([]))
      .toThrow(BadRequestException);
  });

  it('rejects more than one file', () => {
    expect(() => (service() as any).validateVerificationDocument([file(), file()]))
      .toThrow(BadRequestException);
  });

  it('rejects a non-PDF', () => {
    expect(() => (service() as any).validateVerificationDocument([
      file({ mimetype: 'image/png' }),
    ])).toThrow(BadRequestException);
  });

  it('rejects spoofed PDF MIME by signature', () => {
    expect(() => (service() as any).validateVerificationDocument([
      file({ buffer: Buffer.from('not a pdf') }),
    ])).toThrow(BadRequestException);
  });

  it('retains private broker evidence classification', () => {
    expect(AssetClassification.PRIVATE_BROKER_EVIDENCE)
      .toBe('private_broker_evidence');
  });

  it('exposes only the fixed multipart field and no requirement routes', () => {
    const applicantController = readFileSync(
      'src/broker-applications/broker-applications.controller.ts',
      'utf8',
    );
    const adminController = readFileSync(
      'src/broker-applications/admin-broker-applications.controller.ts',
      'utf8',
    );
    expect(applicantController).toContain("name: 'verificationDocument'");
    expect(applicantController).not.toContain("@Get('requirements')");
    expect(adminController).not.toContain('broker-requirements');
  });
});
