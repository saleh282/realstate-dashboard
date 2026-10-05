'use strict';

const REPLACEMENTS = [
  [/mongodb(?:\+srv)?:\/\/[^@\s/]+@/gi, 'mongodb://[redacted]@'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]'],
  [/([?&](?:key|api[_-]?key|token|secret|signature)=)[^&\s"']+/gi, '$1[redacted]'],
  [
    /\b(password|passwd|secret|token|api[_-]?key|authorization)\b(\s*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
    '$1$2[redacted]',
  ],
];
/** Best-effort scrub so credentials embedded in error text never reach log sinks. */
function redactSensitive(text, maxLength = 2000) {
  let result = String(text ?? '');
  for (const [pattern, replacement] of REPLACEMENTS) result = result.replace(pattern, replacement);
  return result.length > maxLength ? `${result.slice(0, maxLength)}…[truncated]` : result;
}

Object.assign(exports, { redactSensitive });
