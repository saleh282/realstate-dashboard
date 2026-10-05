'use strict';
const { isIP } = require('node:net');
const { HttpException } = require('../common/http/errors');

function clientIp(req) {
  return isIP(req.ip || '')
    ? req.ip
    : req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}
function rateLimit({ default: { limit = 20, ttl = 60000 } = {} } = {}) {
  const buckets = new Map();
  let nextSweep = 0;
  return (req, res, next) => {
    const now = Date.now();
    if (now >= nextSweep) {
      for (const [key, bucket] of buckets) if (bucket.reset <= now) buckets.delete(key);
      nextSweep = now + ttl;
    }
    const key = clientIp(req);
    let bucket = buckets.get(key);
    if (!bucket || bucket.reset <= now) {
      bucket = { count: 0, reset: now + ttl };
      buckets.set(key, bucket);
    }
    bucket.count++;
    res.set('X-RateLimit-Limit', String(limit));
    res.set('X-RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
    res.set('X-RateLimit-Reset', String(Math.ceil((bucket.reset - now) / 1000)));
    if (bucket.count <= limit) return next();
    res.set('Retry-After', String(Math.ceil((bucket.reset - now) / 1000)));
    return next(new HttpException({ message: 'محاولات كثيرة جداً، حاول مرة أخرى بعد قليل' }, 429));
  };
}
module.exports = { rateLimit, clientIp };
