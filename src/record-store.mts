/**
 * Holds captured edges in chrome.storage.local until a drain can emit them.
 *
 * ONE STORAGE KEY PER EDGE. Persisting to a single array means concurrent
 * handlers read the same value, push, and write back over each other, so
 * records disappear and the module looks like it never fired. Distinct keys
 * cannot collide, so there is nothing to serialise.
 *
 * Each kind of edge gets its own key prefix, so a visit and an opener edge for
 * the same visit can both be held.
 */

export interface StoredRecord {
  visit_time: number;
}

export interface StoredEdge extends StoredRecord {
  visit_id: string;
}

export class RecordStore<T extends StoredRecord> {
  constructor(private readonly prefix: string, private readonly idOf: (record: T) => string) {}

  async put(record: T): Promise<void> {
    await chrome.storage.local.set({ [this.keyFor(this.idOf(record))]: record })
  }

  /**
   * Reads by key rather than pulling the extension's whole local storage down to
   * filter it — this module's records are a handful among everything every other
   * module keeps.
   */
  async readAll(): Promise<T[]> {
    const keys = (await chrome.storage.local.getKeys()).filter((key) => key.startsWith(this.prefix))

    if (keys.length === 0) {
      return []
    }

    const stored = await chrome.storage.local.get(keys)

    return keys.map((key) => stored[key] as T).filter((record) => record !== undefined)
  }

  async read(id: string): Promise<T | undefined> {
    const key = this.keyFor(id)
    const stored = await chrome.storage.local.get(key)

    return stored[key] as T | undefined
  }

  async forget(ids: string[]): Promise<void> {
    await chrome.storage.local.remove(ids.map((id) => this.keyFor(id)))
  }

  /** Discard everything held. Used when the module is turned off. */
  async clear(): Promise<number> {
    const records = await this.readAll()

    if (records.length > 0) {
      await this.forget(records.map(this.idOf))
    }

    return records.length
  }

  /** Drop anything older than the cutoff, so a wedged run cannot grow the store. */
  async sweep(olderThanMs: number): Promise<number> {
    const stale = (await this.readAll()).filter((record) => record.visit_time < olderThanMs)

    if (stale.length > 0) {
      await this.forget(stale.map(this.idOf))
    }

    return stale.length
  }

  private keyFor(id: string): string {
    return `${this.prefix}${id}`
  }
}
