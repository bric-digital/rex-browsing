/**
 * Links a visit to the tab it happened in, from rex-page-events' url-active
 * records.
 *
 * A visit and its url-active record arrive in either order, and a service
 * worker can restart between the two, so both wait in storage: visits in the
 * visit store, url-active records in chrome.storage.session.
 */

import type { RexPageUrlActiveEvent } from '@bric/rex-types/types'
import { storageIdOf, type TabLink, type VisitRecord, type VisitStore } from './visit-store.mjs'

const STORAGE_KEY = 'rexBrowsingUrlActive'

const MAX_HELD = 256

/** The fields a url-active record must carry; the tab fields are copied when present. */
export type UrlActiveRecord = Pick<RexPageUrlActiveEvent, 'url' | 'url_shown_at'> & Partial<RexPageUrlActiveEvent>

export function isUrlActiveRecord(value: unknown): value is UrlActiveRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const record = value as Record<string, unknown>

  return typeof record.url === 'string' && typeof record.url_shown_at === 'number'
}

function linkFrom(record: UrlActiveRecord): TabLink {
  return {
    ...(record.tab_id === undefined ? {} : { tab_id: record.tab_id }),
    ...(record.window_id === undefined ? {} : { window_id: record.window_id }),
    ...(record.session_id === undefined ? {} : { session_id: record.session_id }),
    page_events_url_shown_at: record.url_shown_at
  }
}

export class TabLinker {
  /**
   * Held records are one storage value, so writes are queued: two messages
   * read-modify-writing it at once would each drop the other's record.
   */
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly store: VisitStore, private readonly tolerance: () => number) {}

  async acceptUrlActive(record: UrlActiveRecord): Promise<void> {
    if (record.tab_id === undefined || record.window_id === undefined || record.session_id === undefined) {
      console.warn('[rex-browsing] Url-active record is missing tab fields:', record)
    }

    const stored = this.writes.then(async () => {
      const held = await this.readHeld()

      held.push(record)
      await chrome.storage.session.set({ [STORAGE_KEY]: held.slice(-MAX_HELD) })
    })

    this.writes = stored.catch(() => undefined)
    await stored

    for (const visit of await this.store.readAll()) {
      const current = visit.link?.page_events_url_shown_at

      if (this.matches(visit, record) && (current === undefined || current < record.url_shown_at)) {
        await this.store.attachLink(storageIdOf(visit), linkFrom(record))
      }
    }
  }

  async linkVisit(visit: VisitRecord): Promise<void> {
    let newest: UrlActiveRecord | null = null

    for (const record of await this.readHeld()) {
      if (this.matches(visit, record) && (newest === null || record.url_shown_at > newest.url_shown_at)) {
        newest = record
      }
    }

    if (newest !== null) {
      await this.store.attachLink(storageIdOf(visit), linkFrom(newest))
    }
  }

  /** Discard every held record. Used when the module is turned off. */
  async clear(): Promise<void> {
    await chrome.storage.session.remove(STORAGE_KEY)
  }

  private matches(visit: VisitRecord, record: UrlActiveRecord): boolean {
    const tolerance = this.tolerance()

    return tolerance > 0
      && visit.url === record.url
      && Math.abs(visit.visit_time - record.url_shown_at) <= tolerance
  }

  private async readHeld(): Promise<UrlActiveRecord[]> {
    const stored = await chrome.storage.session.get(STORAGE_KEY)
    const held = stored[STORAGE_KEY]

    return Array.isArray(held) ? held.filter(isUrlActiveRecord) : []
  }
}
