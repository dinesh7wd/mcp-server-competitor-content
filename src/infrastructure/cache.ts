export interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

export class LruCache {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly store = new Map<string, CacheEntry<unknown>>();

  constructor(maxEntries: number, ttlSeconds: number) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlSeconds * 1000;
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlSeconds?: number): void {
    if (this.store.has(key)) this.store.delete(key);
    const ttl = ttlSeconds !== undefined ? ttlSeconds * 1000 : this.ttlMs;
    this.store.set(key, { value, expiresAt: Date.now() + ttl });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) return;
      this.store.delete(oldest);
    }
  }

  clear(): void {
    this.store.clear();
  }
}
