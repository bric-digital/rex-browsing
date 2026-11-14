/**
 * Records the browser's own pages, which Chrome keeps out of history entirely.
 *
 * `chrome://` pages, including AI Mode at `chrome://contextual-tasks/`, never
 * reach the history database, so `onVisited` does not fire for them and there is
 * no visit id, referrer or transition to resolve. `tabs.onUpdated` still carries
 * the committed URL, so the page is recorded from there, with the time it was
 * seen. AI-Extension#132.
 *
 * Opt-in through `internal_pages`: these addresses can carry text the
 * participant typed, such as `chrome://history/?q=`.
 */

import { EdgeStore, type StoredRecord } from './edge-store.mjs'

const KEY_PREFIX = 'rexBrowsingPage:'

/** Edge serves its own pages as `edge://`. */
export const UNRECORDED_SCHEMES = ['chrome', 'chrome-untrusted', 'edge']

export interface PageRecord extends StoredRecord {
  page_id: string;
  tab_id: number;
  url: string;
}

export class PageStore extends EdgeStore<PageRecord> {
  constructor() {
    super(KEY_PREFIX, (record) => record.page_id)
  }
}

export interface InternalPageDependencies {
  store: PageStore;
  /** The study's `internal_pages` setting. */
  wanted: () => boolean;
}

export class InternalPageRecorder {
  constructor(private readonly deps: InternalPageDependencies) {}

  isWanted(): boolean {
    return this.deps.wanted()
  }

  async pageCommitted(tabId: number, url: string): Promise<boolean> {
    if (!this.isWanted() || !isUnrecorded(url)) {
      return false
    }

    const seenAt = Date.now()

    await this.deps.store.put({
      page_id: `${tabId}:${seenAt}`,
      tab_id: tabId,
      visit_time: seenAt,
      url
    })

    return true
  }
}

function isUnrecorded(url: string): boolean {
  const scheme = url.slice(0, url.indexOf(':')).toLowerCase()
  return UNRECORDED_SCHEMES.includes(scheme)
}
