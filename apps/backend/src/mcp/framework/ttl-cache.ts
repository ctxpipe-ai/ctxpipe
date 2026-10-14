/**
 * A small in-process cache. An entry ends `ttlMs` after it was set, and a
 * read does not extend it. When the cache holds more than `maxEntries`, it
 * drops the entry that was used least recently.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expires: number }>()

  constructor(
    private readonly options: { ttlMs: number; maxEntries: number },
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expires <= Date.now()) {
      this.entries.delete(key)
      return undefined
    }
    // Move the entry to the end, so that the first entry is the least recent.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: T): void {
    this.entries.delete(key)
    this.entries.set(key, { value, expires: Date.now() + this.options.ttlMs })
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.options.maxEntries) break
      this.entries.delete(oldest)
    }
  }
}
