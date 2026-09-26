import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PropertyAttributeFieldErrorCode,
  PropertyAttributesMalformedReason,
  parseAttributes,
  propertyAttributesInvalid,
  propertyAttributesMalformed,
  sanitizeFormLabel,
  validateAgainstVersion,
} from '../src/common/validators/property-attributes';
import { PropertyErrorCode } from '../src/common/errors/property-error-codes';
import { PROPERTY_ATTRIBUTE_DATA_TYPES } from '../src/property-attributes/property-attribute.constants';
import { LEGACY_RESIDENTIAL_FIELDS } from '../src/property-form-definitions/property-form-definition.constants';

/**
 * DPF-011: the shared validation vectors are the frozen V1 contract (and the
 * future Flutter parity suite). Every case runs the real transport parser and
 * the pure validator exactly as a write will.
 */
type VectorCase = {
  id: string;
  group: string;
  description: string;
  version: string;
  operationType: 'sale' | 'rent';
  attributes: string;
  expect: { ok: true; attributes: Record<string, unknown> } | { ok: false; malformed: string } | { ok: false; fieldErrors: Array<{ key: string; code: string; params: Record<string, unknown> }> };
};
const vectors = JSON.parse(readFileSync(join(__dirname, 'fixtures/dpf/validation-vectors.json'), 'utf8')) as {
  vectorsVersion: number;
  rendererVersion: number;
  catalog: Record<string, string[]>;
  versions: Record<string, { fields: any[] }>;
  cases: VectorCase[];
};
const catalogLookup = (group: string, code: string) => (vectors.catalog[group] ?? []).includes(code);

function run(vectorCase: VectorCase) {
  const parsed = parseAttributes(vectorCase.attributes);
  if ('reason' in parsed) return { ok: false, malformed: parsed.reason };
  const result = validateAgainstVersion(vectors.versions[vectorCase.version], vectorCase.operationType, parsed.attributes, catalogLookup);
  return 'fieldErrors' in result ? { ok: false, fieldErrors: result.fieldErrors } : { ok: true, attributes: result.attributes };
}

describe('DPF-011 shared validation vectors', () => {
  it('is a versioned contract with at least 150 cases and unique ids', () => {
    expect(vectors.vectorsVersion).toBe(1);
    expect(vectors.rendererVersion).toBe(1);
    expect(vectors.cases.length).toBeGreaterThanOrEqual(150);
    expect(new Set(vectors.cases.map((vectorCase) => vectorCase.id)).size).toBe(vectors.cases.length);
  });

  it('keeps the vectors\' legacy form identical to the seeded legacy definition', () => {
    expect(vectors.versions.legacy.fields).toEqual(LEGACY_RESIDENTIAL_FIELDS);
  });

  it('covers every data type, every field-error code and every malformation reason', () => {
    const types = new Set(Object.values(vectors.versions).flatMap((version) => version.fields.map((field) => field.dataType)));
    expect([...types].sort()).toEqual([...PROPERTY_ATTRIBUTE_DATA_TYPES].sort());
    const codes = new Set(vectors.cases.flatMap((vectorCase) => ('fieldErrors' in vectorCase.expect ? vectorCase.expect.fieldErrors.map((error) => error.code) : [])));
    expect([...codes].sort()).toEqual(Object.values(PropertyAttributeFieldErrorCode).sort());
    const reasons = new Set(vectors.cases.flatMap((vectorCase) => ('malformed' in vectorCase.expect ? [vectorCase.expect.malformed] : [])));
    expect([...reasons].sort()).toEqual(Object.values(PropertyAttributesMalformedReason).sort());
    expect(vectors.cases.some((vectorCase) => vectorCase.expect.ok)).toBe(true);
  });

  it.each(vectors.cases.map((vectorCase) => [`${vectorCase.id} ${vectorCase.description}`, vectorCase] as const))('%s', (_name, vectorCase) => {
    const actual: any = run(vectorCase);
    expect(actual).toEqual(vectorCase.expect);
    if (actual.ok && 'attributes' in vectorCase.expect) expect(Object.keys(actual.attributes)).toEqual(Object.keys(vectorCase.expect.attributes));
  });
});

describe('DPF-011 validation engine guarantees beyond the vectors', () => {
  it('returns a null-prototype map so inherited names can never be read or written through it', () => {
    const parsed = parseAttributes('{"bedrooms":2}');
    expect('attributes' in parsed && Object.getPrototypeOf(parsed.attributes)).toBeNull();
  });

  it('never mutates Object.prototype while rejecting pollution payloads', () => {
    for (const raw of ['{"__proto__":{"polluted":true}}', '{"constructor":{"prototype":{"polluted":true}}}']) parseAttributes(raw);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects non-string transport values as invalid JSON', () => {
    expect(parseAttributes({ bedrooms: 1 })).toEqual({ ok: false, reason: 'INVALID_JSON' });
    expect(parseAttributes(undefined)).toEqual({ ok: false, reason: 'INVALID_JSON' });
  });

  it('builds the frozen error envelopes with everything under details', () => {
    expect(propertyAttributesMalformed(PropertyAttributesMalformedReason.NESTED_VALUE).getResponse()).toEqual({
      message: 'بيانات مواصفات العقار غير صالحة', code: PropertyErrorCode.ATTRIBUTES_MALFORMED, details: { reason: 'NESTED_VALUE' },
    });
    const invalid = propertyAttributesInvalid('64b000000000000000000001', [{ key: 'bedrooms', code: PropertyAttributeFieldErrorCode.MIN, params: { min: 1 } }]);
    expect(invalid.getStatus()).toBe(400);
    expect(invalid.getResponse()).toEqual({
      message: 'بعض بيانات مواصفات العقار غير صالحة', code: 'PROPERTY_ATTRIBUTES_INVALID',
      details: { formDefinitionVersionId: '64b000000000000000000001', fieldErrors: [{ key: 'bedrooms', code: 'MIN', params: { min: 1 } }] },
    });
  });

  it('sanitizes Admin labels: NFC, controls and bidi overrides removed, LRM/RLM and ZWJ/ZWNJ kept', () => {
    expect(sanitizeFormLabel('  غرف\u0000 النوم‮ ')).toBe('غرف النوم');
    expect(sanitizeFormLabel('‏الدور‍‌')).toBe('‏الدور‍‌');
    expect(sanitizeFormLabel('é\n⁦x⁩')).toBe('éx');
  });

  it('lets a caller supply its own engineering rule list (no rule reaches the validator from data)', () => {
    const fields = [{ key: 'floor', dataType: 'integer', labelAr: 'x', required: true, order: 1 }, { key: 'totalFloors', dataType: 'integer', labelAr: 'y', required: true, order: 2 }] as any;
    const parsed = parseAttributes('{"floor":9,"totalFloors":2}');
    if (!('attributes' in parsed)) throw new Error('unexpected');
    expect(validateAgainstVersion({ fields }, 'sale', parsed.attributes, () => false).ok).toBe(false);
    expect(validateAgainstVersion({ fields }, 'sale', parsed.attributes, () => false, []).ok).toBe(true);
  });
});
