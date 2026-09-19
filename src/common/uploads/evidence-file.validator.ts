import { BadRequestException } from '@nestjs/common';
import { EvidenceErrorCode } from '../errors/evidence-error-codes';

export type EvidenceFileKind = 'image' | 'document';

export interface EvidenceFilePolicy {
  kind: EvidenceFileKind;
  maxBytes: number;
  maxImagePixels?: number;
  allowPdf?: boolean;
}

export type DetectedEvidenceFile = {
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
  format: 'jpg' | 'png' | 'webp' | 'pdf';
  width?: number;
  height?: number;
};

function invalid(message: string, code = EvidenceErrorCode.FILE_INVALID): never {
  throw new BadRequestException({ message, code });
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return undefined;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.length) return undefined;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return undefined;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) return undefined;
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return undefined;
}

function detect(bytes: Buffer): DetectedEvidenceFile | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return undefined;
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (!width || !height || !bytes.includes(Buffer.from('IEND'))) return undefined;
    return { mime: 'image/png', format: 'png', width, height };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const dimensions = jpegDimensions(bytes);
    return dimensions ? { mime: 'image/jpeg', format: 'jpg', ...dimensions } : undefined;
  }
  if (
    bytes.length >= 30 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP' &&
    bytes.readUInt32LE(4) + 8 <= bytes.length
  ) {
    const chunk = bytes.subarray(12, 16).toString('ascii');
    if (chunk === 'VP8X') {
      return {
        mime: 'image/webp',
        format: 'webp',
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
      };
    }
    if (chunk === 'VP8 ' || chunk === 'VP8L') return { mime: 'image/webp', format: 'webp' };
    return undefined;
  }
  if (bytes.length >= 12 && bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
    const tail = bytes.subarray(Math.max(0, bytes.length - 2048)).toString('latin1');
    if (!tail.includes('%%EOF')) return undefined;
    return { mime: 'application/pdf', format: 'pdf' };
  }
  return undefined;
}

export function validateEvidenceFile(file: Express.Multer.File, policy: EvidenceFilePolicy): DetectedEvidenceFile {
  if (!file?.buffer?.length) invalid('ملف الإثبات فارغ أو تالف');
  if (!Number.isSafeInteger(file.buffer.length) || file.buffer.length > policy.maxBytes) {
    invalid('حجم ملف الإثبات يتجاوز الحد المسموح', EvidenceErrorCode.FILE_TOO_LARGE);
  }
  const allowedMime = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    ...(policy.allowPdf ? ['application/pdf'] : []),
  ]);
  if (!allowedMime.has(file.mimetype)) {
    invalid('صيغة ملف الإثبات غير مدعومة', EvidenceErrorCode.FILE_TYPE_UNSUPPORTED);
  }
  const detected = detect(file.buffer);
  if (!detected || detected.mime !== file.mimetype) {
    invalid('محتوى ملف الإثبات لا يطابق نوعه أو أن الملف تالف');
  }
  if (policy.kind === 'image' && detected.mime === 'application/pdf') {
    invalid('صيغة ملف الإثبات غير مدعومة', EvidenceErrorCode.FILE_TYPE_UNSUPPORTED);
  }
  if (detected.width && detected.height && policy.maxImagePixels) {
    const pixels = detected.width * detected.height;
    if (!Number.isSafeInteger(pixels) || pixels > policy.maxImagePixels) {
      invalid('أبعاد صورة الإثبات تتجاوز الحد الآمن', EvidenceErrorCode.IMAGE_DIMENSIONS_INVALID);
    }
  }
  return detected;
}
