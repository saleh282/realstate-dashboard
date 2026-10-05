'use strict';

/** Minimal in-process LRU cache (insertion order of a Map is the recency order). */
class LruCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.entries = new Map();
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new RangeError('LRU capacity must be a positive integer');
  }
  get size() {
    return this.entries.size;
  }
  get(key) {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key);
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }
  set(key, value) {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value);
  }
  has(key) {
    return this.entries.has(key);
  }
}

Object.assign(exports, { LruCache });
