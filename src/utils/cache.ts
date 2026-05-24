// Simple LRU cache with TTL expiry. Used for embedding vectors and search results
// to avoid re-computing expensive operations for repeated queries within a session.
export class LRUCache<T> {
  private map = new Map<string, { value: T; expires: number }>();
  private maxSize: number;
  private ttlMs: number;

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    this.map.delete(key);
    if (this.map.size >= this.maxSize) {
      const first = this.map.keys().next().value!;
      this.map.delete(first);
    }
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
  }

  get size(): number {
    return this.map.size;
  }
}
