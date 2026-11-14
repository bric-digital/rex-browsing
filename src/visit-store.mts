/**
 * Holds recorded visits until a drain can emit them.
 *
 * The record keeps what Chrome reports for the visit itself. What describes the
 * history item (title, counts) is read at drain, because `onVisited` often
 * fires before a page's title is known.
 */

import type { BrowsingVisit } from './visit-lookup.mts'
import { EdgeStore, type StoredEdge } from './edge-store.mjs'

const KEY_PREFIX = 'rexBrowsingVisit:'

/** The tab a visit happened in, from rex-page-events. */
export interface TabLink {
  tab_id: number;
  window_id: number;
  session_id: string;
  page_events_url_shown_at: number;
}

export interface VisitRecord extends StoredEdge {
  referring_visit_id: string;
  transition_type: string;
  is_local: boolean;
  url: string;
  link?: TabLink;
}

export class VisitStore extends EdgeStore<VisitRecord> {
  constructor() {
    super(KEY_PREFIX, (record) => record.visit_id)
  }

  async record(visit: BrowsingVisit): Promise<void> {
    await this.put({
      visit_id: visit.visitId,
      referring_visit_id: visit.referringVisitId,
      visit_time: visit.visitTime,
      transition_type: visit.transition,
      is_local: visit.isLocal,
      url: visit.url
    })
  }

  /** Adds the tab link to a stored visit. Does nothing when the visit is not held. */
  async attachLink(visitId: string, link: TabLink): Promise<void> {
    const record = await this.read(visitId)

    if (record !== undefined) {
      await this.put({ ...record, link })
    }
  }
}
