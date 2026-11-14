/**
 * Holds recorded visits until a drain can emit them.
 *
 * The record keeps what Chrome reports for the visit itself. What describes the
 * history item (title, counts) is read at drain, because `onVisited` often
 * fires before a page's title is known.
 */

import type { BrowsingVisit } from './visit-lookup.mts'
import { EdgeStore, type StoredRecord } from './edge-store.mjs'

const KEY_PREFIX = 'rexBrowsingVisit:'

/** The tab a visit happened in, from rex-page-events. */
export interface TabLink {
  tab_id?: number;
  window_id?: number;
  session_id?: string;
  page_events_url_shown_at: number;
}

/** Why a visit was recorded without its visit ids. */
export type IdsUnavailable = 'over_ceiling' | 'lookup_failed'

interface HeldVisit extends StoredRecord {
  url: string;
  link?: TabLink;
}

export interface IdentifiedVisitRecord extends HeldVisit {
  visit_id: string;
  referring_visit_id: string;
  transition_type: string;
  is_local: boolean;
  ids_unavailable?: undefined;
}

/** A visit whose ids could not be had. The title is kept from `onVisited`, since nothing else names it. */
export interface VisitRecordWithoutIds extends HeldVisit {
  title: string;
  ids_unavailable: IdsUnavailable;
  visit_id?: undefined;
}

export type VisitRecord = IdentifiedVisitRecord | VisitRecordWithoutIds

/** A short, stable hash, so a key stays short whatever the URL's length. */
function urlHash(url: string): string {
  let hash = 5381

  for (let index = 0; index < url.length; index += 1) {
    hash = ((hash * 33) ^ url.charCodeAt(index)) >>> 0
  }

  return hash.toString(36)
}

/**
 * The record's storage id: its visit id, or for a visit without ids its time
 * and URL, so two visits to one URL at different times are two records.
 */
export function storageIdOf(record: VisitRecord): string {
  return record.ids_unavailable === undefined
    ? record.visit_id
    : `nid:${record.visit_time}:${urlHash(record.url)}`
}

export class VisitStore extends EdgeStore<VisitRecord> {
  constructor() {
    super(KEY_PREFIX, storageIdOf)
  }

  async record(visit: BrowsingVisit): Promise<VisitRecord> {
    const record: VisitRecord = {
      visit_id: visit.visitId,
      referring_visit_id: visit.referringVisitId,
      visit_time: visit.visitTime,
      transition_type: visit.transition,
      is_local: visit.isLocal,
      url: visit.url
    }

    await this.put(record)
    return record
  }

  async recordWithoutIds(url: string, title: string, visitTime: number, reason: IdsUnavailable): Promise<VisitRecord> {
    const record: VisitRecord = { url, title, visit_time: visitTime, ids_unavailable: reason }

    await this.put(record)
    return record
  }

  /** Adds the tab link to a stored visit. Does nothing when the visit is not held. */
  async attachLink(storageId: string, link: TabLink): Promise<void> {
    const record = await this.read(storageId)

    if (record !== undefined) {
      await this.put({ ...record, link })
    }
  }
}
