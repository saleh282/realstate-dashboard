import { isIP } from 'net';

export type TrustProxySetting = false | number | string[];

const KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);
const MAX_HOPS = 10;

function isAddressOrCidr(value: string): boolean {
  const [address, prefix, ...rest] = value.split('/');
  if (rest.length) return false;
  const family = isIP(address);
  if (!family) return false;
  if (prefix === undefined) return true;
  if (!/^\d+$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

function isWildcard(value: string): boolean {
  const [address, prefix] = value.split('/');
  return prefix === '0' && (address === '0.0.0.0' || address === '::');
}

/**
 * TRUST_PROXY controls which peers may supply X-Forwarded-For. Unset means no
 * proxy is trusted (the header is ignored). Accepted values:
 *  - a comma-separated list of IPs/CIDRs/keywords (loopback, linklocal,
 *    uniquelocal) identifying the proxies allowed to set the header. This is the
 *    recommended form: Express skips trusted addresses from the right and takes
 *    the first untrusted one, so spoofed leftmost entries never win.
 *  - a positive hop count. Only safe when every request path crosses exactly
 *    that many proxies, because the entry N hops out is trusted as the client.
 * "true" (trust everyone) is always rejected, as is a match-everything CIDR.
 */
export function parseTrustProxy(raw: string | undefined): {
  setting: TrustProxySetting;
  errors: string[];
} {
  const value = (raw ?? '').trim();
  if (!value || value.toLowerCase() === 'false') return { setting: false, errors: [] };

  if (value.toLowerCase() === 'true') {
    return {
      setting: false,
      errors: ['TRUST_PROXY=true would trust any client-supplied X-Forwarded-For; list proxy IPs/CIDRs instead'],
    };
  }

  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops === 0) return { setting: false, errors: [] };
    if (hops > MAX_HOPS) {
      return { setting: false, errors: [`TRUST_PROXY hop count must be between 1 and ${MAX_HOPS}`] };
    }
    return { setting: hops, errors: [] };
  }

  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  const errors: string[] = [];
  for (const entry of entries) {
    if (KEYWORDS.has(entry.toLowerCase())) continue;
    if (!isAddressOrCidr(entry)) {
      errors.push(`TRUST_PROXY entry is not an IP, CIDR, or supported keyword: ${entry}`);
    } else if (isWildcard(entry)) {
      errors.push(`TRUST_PROXY entry trusts every address and is not allowed: ${entry}`);
    }
  }
  if (!entries.length) errors.push('TRUST_PROXY must not be empty');
  return { setting: errors.length ? false : entries, errors };
}
