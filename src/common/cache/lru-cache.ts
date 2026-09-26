/** Minimal in-process LRU cache (insertion order of a Map is the recency order). */
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('LRU capacity must be a positive integer');
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key)!;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value as K);
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }
}
