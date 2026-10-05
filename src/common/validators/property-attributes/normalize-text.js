'use strict';

/**
 * Text normalization for attribute values (frozen §B4) and Admin-authored
 * labels/help (frozen §B7). No markup is ever interpreted.
 */
/** C0 and C1 control characters, DEL included. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;
/** C0/C1 controls except LF, for multi-line text after CR/CRLF became LF. */
const CONTROL_CHARACTERS_EXCEPT_LF = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;
/** Bidi embeddings/overrides (U+202A-U+202E) and isolates (U+2066-U+2069). LRM/RLM and ZWJ/ZWNJ are kept. */
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** False for strings with unpaired UTF-16 surrogates (not representable as UTF-8). */
function isWellFormedText(value) {
  return !LONE_SURROGATE.test(value);
}
/**
 * `text`: NFC, controls and newlines removed, bidi controls removed, trimmed.
 * `textarea`: the same but LF is kept (CR/CRLF become LF) and runs of three or
 * more LF collapse to two.
 */
function normalizeAttributeText(value, multiline) {
  let text = value.normalize('NFC');
  if (multiline) {
    text = text
      .replace(/\r\n?/g, '\n')
      .replace(CONTROL_CHARACTERS_EXCEPT_LF, '')
      .replace(BIDI_CONTROLS, '');
    text = text.replace(/\n{3,}/g, '\n\n');
  } else {
    text = text.replace(CONTROL_CHARACTERS, '').replace(BIDI_CONTROLS, '');
  }
  return text.trim();
}
/** Select codes and dates are compared as written: NFC and trimmed only. */
function normalizeAttributeToken(value) {
  return value.normalize('NFC').trim();
}
/** Length in Unicode code points, as the contract counts it. */
function codePointLength(value) {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}
/** Frozen §B7: labels, help and placeholders saved by Admin. */
function sanitizeFormLabel(value) {
  return value.normalize('NFC').replace(CONTROL_CHARACTERS, '').replace(BIDI_CONTROLS, '').trim();
}

Object.assign(exports, {
  isWellFormedText,
  normalizeAttributeText,
  normalizeAttributeToken,
  codePointLength,
  sanitizeFormLabel,
});
