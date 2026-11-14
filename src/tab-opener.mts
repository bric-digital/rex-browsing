/**
 * Attributes a new tab's first visit to the page that opened it.
 *
 * Chrome records no referring visit across a tab boundary: a link opened with a
 * middle click, a modifier click, `target="_blank"` or `window.open()` lands
 * with `referringVisitId` "0", indistinguishable from a typed address. The
 * relationship exists only on `chrome.tabs`: the new tab's `openerTabId` names
 * the tab it was opened from, and that tab's current page is the referrer.
 *
 * Measured 2026-09-10 (plans/rex-visit-graph/2026-09-10-tab-opener-attribution-spike.md):
 * `openerTabId` is present on `tabs.onCreated` for every opening method;
 * `pendingUrl` is present only for middle and modifier clicks, so the new tab's
 * first navigation is read from `tabs.onUpdated` instead, which carries the
 * committed URL on every method. In a redirect chain that URL is the landing
 * page, never the hop, so the chain's root is resolved at drain time from the
 * hops this module already holds.
 *
 * An opener edge is stored under its own key prefix, so a hop and an opener
 * edge for the same visit can both be held.
 */

import { EdgeStore, type StoredEdge } from './edge-store.mjs'
import type { VisitRecord } from './visit-store.mjs'
import { isRecordedScheme, newestVisit, visitCount } from './visit-lookup.mjs'

const KEY_PREFIX = 'rexBrowsingOpener:'

/**
 * How long after creation a tab's first navigation still counts as the thing
 * the opener opened. A tab left blank longer than this and then navigated by
 * hand is not a click-through, and Chrome would not attribute it either.
 */
const FIRST_NAVIGATION_WINDOW_MS = 30_000

export interface OpenerRecord extends StoredEdge {
  /** What Chrome recorded as the first visit's referrer, "0" for a new tab. */
  referring_visit_id: string;
  /** The newest visit of the opener tab's page when the tab was created. */
  opener_visit_id: string;
  url: string;
  transition: string;
}

interface PendingOpener {
  /** Resolved asynchronously; reserved synchronously so a fast first navigation still finds it. */
  openerVisitId: Promise<string | null>;
  createdAt: number;
}

export class OpenerStore extends EdgeStore<OpenerRecord> {
  constructor() {
    super(KEY_PREFIX, (record) => record.visit_id)
  }
}

/**
 * The visit an opener edge should attach to.
 *
 * The first URL a tab commits may be the landing of a redirect chain whose root
 * is a redirect step this module recorded. Chrome recorded "0" on that root, not on the
 * landing, so the edge belongs there: it fills exactly the gap Chrome left, and
 * landing -> hop -> opener is then walkable end to end. If the root is not
 * among the visits held, the edge stays on the first committed visit.
 */
export function chainRoot(record: OpenerRecord, visits: VisitRecord[]): { visit_id: string; visit_time: number; url: string } {
  const byId = new Map(visits.map((visit) => [visit.visit_id, visit]))
  let current: { visit_id: string; referring_visit_id: string; visit_time: number; url: string } = record

  // Bounded, so a cycle in stored data cannot hang the drain.
  for (let steps = 0; steps < 16; steps += 1) {
    const hop = byId.get(current.referring_visit_id)

    if (hop === undefined) {
      break
    }

    current = hop
  }

  return { visit_id: current.visit_id, visit_time: current.visit_time, url: current.url }
}

export interface TabOpenerDependencies {
  store: OpenerStore;
  /** Ceiling on an opener's visit count; non-positive means no ceiling. */
  maxOpenerVisits: () => number;
}

export class TabOpenerTracker {
  private readonly pending = new Map<number, PendingOpener>()

  constructor(private readonly deps: TabOpenerDependencies) {}

  /**
   * A tab was created. If a page opened it, remember which visit that page was
   * on, so the tab's first navigation can be attributed to it.
   *
   * The entry is reserved before anything is awaited: the first navigation can
   * commit within a millisecond of creation, and a lookup still in flight must
   * not lose it.
   *
   * The lookup starts here rather than in `tabNavigated()`, which means a new tab
   * whose first page is not recorded has already paid for one it will not use.
   * That is deliberate. It came up while investigating AI-Extension#124,
   * which reported the cost of this lookup but not this part of it. Deferring would
   * resolve the opener's NEWEST visit at navigation time instead of at creation
   * time, and on the pages this matters for — a dashboard re-recording a visit
   * every few seconds — those are different visits. The attribution window is 30
   * seconds, so the edge could name a visit ten later than the one that opened
   * the tab. Paying for an occasional unused lookup is the cheaper error than
   * silently attributing to the wrong visit of the right page.
   */
  tabCreated(tab: chrome.tabs.Tab): boolean {
    if (tab.id === undefined || tab.openerTabId === undefined) {
      return false
    }

    this.pending.set(tab.id, {
      openerVisitId: this.resolveOpenerVisit(tab.openerTabId),
      createdAt: Date.now()
    })

    return true
  }

  /**
   * A tab committed a URL. The first real one after creation is the visit the
   * opener opened; later ones are the participant browsing on.
   */
  async tabNavigated(tabId: number, url: string): Promise<boolean> {
    const entry = this.pending.get(tabId)

    if (entry === undefined) {
      return false
    }

    // A tab opened empty and then navigated by its opener commits about:blank
    // first. That is not the visit; the next one is.
    if (url === '' || url === 'about:blank') {
      return false
    }

    this.pending.delete(tabId)

    if (Date.now() - entry.createdAt > FIRST_NAVIGATION_WINDOW_MS) {
      return false
    }

    if (!isRecordedScheme(url)) {
      return false
    }

    const openerVisitId = await entry.openerVisitId

    if (openerVisitId === null) {
      return false
    }

    const visit = await newestVisit(url)

    if (visit === null) {
      return false
    }

    await this.deps.store.put({
      visit_id: visit.visitId,
      referring_visit_id: visit.referringVisitId,
      opener_visit_id: openerVisitId,
      visit_time: visit.visitTime,
      url,
      transition: visit.transition
    })

    return true
  }

  tabRemoved(tabId: number): void {
    this.pending.delete(tabId)
  }

  /** Drop every reservation. Used when listening stops. */
  forgetAll(): void {
    this.pending.clear()
  }

  /**
   * The opener tab's current visit, or null when it has no page worth
   * attributing to: a blank tab, an extension page, a host without the `tabs`
   * permission (Chrome then reports no URL), or a tab that has already gone.
   * The URL is used to resolve the id and then dropped.
   */
  private async resolveOpenerVisit(openerTabId: number): Promise<string | null> {
    let url: string | undefined

    try {
      url = (await chrome.tabs.get(openerTabId)).url
    } catch {
      return null
    }

    if (url === undefined || !isRecordedScheme(url)) {
      return null
    }

    if (await this.tooManyVisits(url)) {
      return null
    }

    const visit = await newestVisit(url)

    return visit === null ? null : visit.visitId
  }

  /**
   * Whether this opener is too expensive to resolve.
   *
   * The ceiling exists because `getVisits()` cannot be bounded: a page that
   * re-records a visit every few seconds costs about a second to resolve, and
   * the opener path pays it per new tab.
   *
   * Fails toward looking up. This decides only what is affordable, so an
   * unanswered question leaves behaviour as it was rather than dropping an edge
   * that was wanted.
   */
  private async tooManyVisits(url: string): Promise<boolean> {
    const ceiling = this.deps.maxOpenerVisits()

    if (ceiling <= 0) {
      return false
    }

    const count = await visitCount(url)

    if (count === null || count <= ceiling) {
      return false
    }

    console.log(`[rex-browsing] Opener has ${count} visits, over the ${ceiling} ceiling; `
      + 'not resolving it. Set browsing.max_opener_visits to change this.')

    return true
  }
}
