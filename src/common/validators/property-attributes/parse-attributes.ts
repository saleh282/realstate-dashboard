import { PROPERTY_ATTRIBUTE_LIMITS, isAllowedAttributeKey } from '../../../property-attributes/property-attribute.constants';
import { PropertyAttributesMalformedReason } from './property-attribute-errors';

/** A parsed value: a JSON primitive, or a flat array of strings (multiSelect). */
export type RawAttributeValue = string | number | boolean | null | string[];
/** Null-prototype map: no inherited keys can be read or polluted through it. */
export type ParsedAttributes = Record<string, RawAttributeValue>;

export type ParseAttributesResult =
  | { ok: true; attributes: ParsedAttributes }
  | { ok: false; reason: PropertyAttributesMalformedReason };

/**
 * Frozen §B2: turns the multipart `attributes` JSON string into a safe flat
 * map, or reports exactly one malformation reason. Checks run in a fixed
 * order (size, JSON, shape, key count, then each key in document order: key
 * name, then value shape). With duplicate JSON keys the last one wins, as in
 * `JSON.parse`.
 */
export function parseAttributes(raw: unknown): ParseAttributesResult {
  if (typeof raw !== 'string') return { ok: false, reason: PropertyAttributesMalformedReason.INVALID_JSON };
  if (Buffer.byteLength(raw, 'utf8') > PROPERTY_ATTRIBUTE_LIMITS.attributesMaxBytes) return { ok: false, reason: PropertyAttributesMalformedReason.TOO_LARGE };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: PropertyAttributesMalformedReason.INVALID_JSON };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) {
    return { ok: false, reason: PropertyAttributesMalformedReason.NOT_OBJECT };
  }
  const keys = Object.keys(parsed);
  if (keys.length > PROPERTY_ATTRIBUTE_LIMITS.attributesMaxKeys) return { ok: false, reason: PropertyAttributesMalformedReason.TOO_MANY_KEYS };
  const attributes: ParsedAttributes = Object.create(null);
  for (const key of keys) {
    if (!isAllowedAttributeKey(key)) return { ok: false, reason: PropertyAttributesMalformedReason.INVALID_KEY };
    const value = (parsed as Record<string, unknown>)[key];
    if (!isFlatValue(value)) return { ok: false, reason: PropertyAttributesMalformedReason.NESTED_VALUE };
    attributes[key] = value as RawAttributeValue;
  }
  return { ok: true, attributes };
}

function isFlatValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
