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

/** A tab field of the wrong type counts as missing. */
function linkFrom(record: UrlActiveRecord): TabLink {
  return {
    ...(typeof record.tab_id === 'number' ? { tab_id: record.tab_id } : {}),
    ...(typeof record.window_id === 'number' ? { window_id: record.window_id } : {}),
    ...(typeof record.session_id === 'string' ? { session_id: record.session_id } : {}),
    page_events_url_shown_at: record.url_shown_at
  }
}

function foldedOldestFirst(links: TabLink[]): TabLink {
  return links.reduce((merged, link) => ({ ...merged, ...link }))
}

/**
 * Links folded oldest first, each field keeping its newest present value. Tab
 * fields come only from links of the newest link's tab; links without a tab id
 * add only the newest `page_events_url_shown_at`.
 */
function mergedLink(links: TabLink[]): TabLink {
  const oldestFirst = links.slice().sort((a, b) => a.page_events_url_shown_at - b.page_events_url_shown_at)
  const tabId = oldestFirst.map((link) => link.tab_id).filter((id) => id !== undefined).pop()

  if (tabId === undefined) {
    return foldedOldestFirst(oldestFirst)
  }

  return {
    ...foldedOldestFirst(oldestFirst.filter((link) => link.tab_id === tabId)),
    page_events_url_shown_at: Math.max(...oldestFirst.map((link) => link.page_events_url_shown_at))
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
    const link = linkFrom(record)

    if (link.tab_id === undefined || link.window_id === undefined || link.session_id === undefined) {
      console.warn('[rex-browsing] Url-active record is missing tab fields:', record)
    }

    const stored = this.writes.then(async () => {
      const held = await this.readHeld()

      held.push(record)
      await chrome.storage.session.set({ [STORAGE_KEY]: held.slice(-MAX_HELD) })
    })

    this.writes = stored.catch(() => undefined)
    await stored

    const held = await this.readHeld()

    for (const visit of await this.store.readAll()) {
      if (this.matches(visit, record)) {
        await this.attachHeld(visit, held)
      }
    }
  }

  async linkVisit(visit: VisitRecord): Promise<void> {
    await this.attachHeld(visit, await this.readHeld())
  }

  /** Discard every held record. Used when the module is turned off. */
  async clear(): Promise<void> {
    await chrome.storage.session.remove(STORAGE_KEY)
  }

  private async attachHeld(visit: VisitRecord, held: UrlActiveRecord[]): Promise<void> {
    const matching = held.filter((record) => this.matches(visit, record))

    if (matching.length > 0) {
      const links = matching.map(linkFrom)

      await this.store.attachLink(storageIdOf(visit), mergedLink(visit.link ? [visit.link, ...links] : links))
    }
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
