/**
 * Records every http and https visit after install, as `rex-browsing-visit`
 * points in the structure of a `rex-history-visit`.
 *
 * `chrome.history.onVisited` fires for every visit, including the redirect
 * steps Chrome keeps out of history search, so a step and its landing page are
 * both recorded and the landing's `referring_visit_id` names the step. Nothing
 * here needs rex-history to be installed.
 *
 * Capture runs until configuration says otherwise. Emission waits for configuration
 * and an identifier, because points must not be dispatched before either exists —
 * but a visit that is not captured while it happens is unrecoverable, so the
 * listener does not wait for anything.
 */

import rexCorePlugin, { REXServiceWorkerModule, registerREXModule, dispatchEvent } from '@bric/rex-core/service-worker'
import { isRecordedScheme, newestVisit } from './visit-lookup.mjs'
import type { RexVisitRecord } from '@bric/rex-types/types'
import {
  VisitStore,
  storageIdOf,
  type IdentifiedVisitRecord,
  type IdsUnavailable,
  type VisitRecord,
  type VisitRecordWithoutIds
} from './visit-store.mjs'
import { historyItemFields, registeredDomain, type HistoryItemFields } from './history-item.mjs'
import { OpenerStore, TabOpenerTracker, chainRoot, type OpenerRecord } from './tab-opener.mjs'
import { InternalPageRecorder, PageStore, type PageRecord } from './internal-pages.mjs'
import { TabLinker } from './tab-link.mjs'

type HistoryCounts = 'last_visit_time' | 'visit_count' | 'typed_count'

/** The emitted visit: the shared record plus what only rex-browsing adds. */
interface BrowsingVisitEvent extends Omit<RexVisitRecord, HistoryCounts> {
  tab_id?: number;
  window_id?: number;
  [key: string]: unknown;
  name: 'rex-browsing-visit';
  ids_unavailable?: IdsUnavailable;
  last_visit_time?: number | undefined;
  visit_count?: number | undefined;
  typed_count?: number | undefined;
}

export interface BrowsingConfig {
  enabled: boolean;
  /** Match window for linking a visit to a tab navigation. 0 disables linking. */
  tab_link_tolerance_ms: number;
  /**
   * Whether a new tab's first visit is attributed to the page that opened it.
   * Chrome records no referrer across a tab boundary; see tab-opener.mts.
   */
  tab_opener_edges: boolean;
  /**
   * Ceiling on a page's visit count, above which its visit ids are not looked up.
   *
   * `getVisits()` takes no time range and no limit, so its cost scales with how
   * many visits a URL has ever had. A page that re-records a visit every few
   * seconds reaches a size where resolving it costs about a second, paid on
   * every visit to it and every tab it opens. Non-positive disables the ceiling.
   */
  max_visits_per_url: number;
  /** Records the browser's own pages, which Chrome keeps out of history. */
  internal_pages: boolean;
  max_record_age_days: number;
}

const CONFIGURATION_TIMEOUT_MS = 10000

const DEFAULT_CONFIG: BrowsingConfig = {
  enabled: false,
  tab_link_tolerance_ms: 5000,
  tab_opener_edges: true,
  // Chrome keeps about 90 days of history, and 100 visits a day for 90 days is
  // 9,000, so 10,000 is above any human browsing while a page re-recording a
  // visit every few seconds passes it within days. The name and value match
  // rex-history's. It is a judgement, not a finding, which is why it is server config.
  max_visits_per_url: 10_000,
  internal_pages: false,
  max_record_age_days: 7
}

function tabFields(record: VisitRecord): { tab_id?: number, window_id?: number } {
  return record.link === undefined
    ? {}
    : {
      tab_id: record.link.tab_id,
      ...(record.link.window_id === undefined ? {} : { window_id: record.link.window_id })
    }
}

function visitWithoutIdsEvent(record: VisitRecordWithoutIds, item: HistoryItemFields | null): BrowsingVisitEvent {
  return {
    name: 'rex-browsing-visit',
    url: record.url,
    visit_time: record.visit_time,
    date: record.visit_time,
    domain: registeredDomain(record.url),
    ids_unavailable: record.ids_unavailable,
    ...(item ?? { title: record.title }),
    ...tabFields(record)
  }
}

function identifiedVisitEvent(record: IdentifiedVisitRecord, item: HistoryItemFields | null): BrowsingVisitEvent {
  return {
    name: 'rex-browsing-visit',
    url: record.url,
    domain: registeredDomain(record.url),
    visit_time: record.visit_time,
    transition_type: record.transition_type,
    is_local: record.is_local,
    date: record.visit_time,
    visit_id: record.visit_id,
    referring_visit_id: record.referring_visit_id,
    ...(item ?? { title: '' }),
    ...tabFields(record)
  }
}

class BrowsingServiceWorkerModule extends REXServiceWorkerModule {
  readonly visitStore = new VisitStore()
  readonly tabLinker = new TabLinker(this.visitStore, () => this.config.tab_link_tolerance_ms)
  readonly openerStore = new OpenerStore()
  readonly tabOpeners = new TabOpenerTracker({
    store: this.openerStore,
    maxVisitsPerUrl: () => this.config.max_visits_per_url
  })
  readonly pageStore = new PageStore()
  readonly internalPages = new InternalPageRecorder({
    store: this.pageStore,
    wanted: () => this.config.internal_pages
  })

  private config: BrowsingConfig = DEFAULT_CONFIG

  /** In-memory, never persisted: a fresh worker restarts with it clear. */
  private draining = false

  /** False until the first updateConfiguration; nothing is recorded before it. */
  private configured = false

  /** Held so it can be removed again; a listener is only removable by reference. */
  private visitListener: ((item: chrome.history.HistoryItem) => void) | null = null

  private openerAndPageListeners: {
    created: (tab: chrome.tabs.Tab) => void;
    updated: (tabId: number, changeInfo: { url?: string }) => void;
    removed: (tabId: number) => void;
  } | null = null

  private tabFieldListener: ((details: { tabId: number; url: string; frameId: number; timeStamp: number }) => void) | null = null

  moduleName(): string {
    return 'rex-browsing'
  }

  /**
   * Self-describes the config surface, the way rex-page-manipulation does, so the
   * shape is discoverable from the module rather than only from its README.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override configurationDetails(): any {
    return {
      browsing: {
        enabled: 'Boolean, default false. True if module is active, false otherwise. When false nothing is '
          + 'captured, nothing is emitted even if a host asks, and anything already captured is discarded. '
          + 'Visits that happen before configuration arrives are not recorded.',
        tab_link_tolerance_ms: 'Number, default 5000. A visit is linked to the tab it happened in '
          + 'from a main-frame navigation to the same URL within this many milliseconds of the visit; '
          + 'the newest such navigation wins. Emits tab_id and window_id. 0 disables linking.',
        tab_opener_edges: 'Boolean, default true. Attributes the first visit in a new tab to the page '
          + 'that opened it, emitted as rex-browsing-opener points. Chrome records no referrer across '
          + 'a tab boundary, so without this a result opened in a new tab arrives from nowhere. Needs the '
          + 'tabs permission in the host; without it nothing is recorded.',
        max_visits_per_url: 'Number, default 10000. A page with more visits than this is not looked '
          + 'up: its visits are recorded without visit ids (ids_unavailable: over_ceiling), each drain '
          + 'sends one rex-browsing-visit-ceiling-exceeded event per such page, and no opener edge is '
          + 'recorded for tabs it opens. getVisits() cannot be bounded and costs about a second on a '
          + 'page that re-records a visit every few seconds. 0 removes the ceiling entirely.',
        internal_pages: 'Boolean, default false. Records the browser\'s own pages (chrome://, '
          + 'chrome-untrusted://, edge://), which Chrome keeps out of history, as rex-browsing-page '
          + 'points with no visit ids. These addresses can carry text the participant typed. Needs '
          + 'the tabs permission.',
        max_record_age_days: 'Number, default 7. Days after which a record that was never emitted is discarded.'
      }
    }
  }

  async setup(): Promise<void> {
    console.log('[rex-browsing/service-worker] Setting up browsing capture')

    await this.refreshConfiguration()
  }

  /** rex-core's activation hook: wait for configuration, then hand this module's own section over. */
  async refreshConfiguration(): Promise<void> {
    try {
      const all = await this.waitForConfiguration()

      this.updateConfiguration(all['browsing'] as Partial<BrowsingConfig> | undefined)

      await this.reconcileStore()
    } catch (error) {
      console.error('[rex-browsing] Failed to load configuration:', error)
    }
  }

  /** Resolves once rex-core has a stored configuration; never resolves if none arrives before the timeout. */
  private waitForConfiguration(): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      rexCorePlugin.handleMessage({
        messageType: 'waitForConfiguration',
        event: { timeout: CONFIGURATION_TIMEOUT_MS }
      }, null, resolve)
    })
  }

  /**
   * Assigns configuration. Synchronous on purpose: a test, a host, or another
   * module can hand this module its settings directly, with no server round trip
   * and nothing to fake. Anything asynchronous a change implies is the caller's,
   * immediately after — see reconcileStore.
   */
  updateConfiguration(section: Partial<BrowsingConfig> | undefined): void {
    this.config = { ...DEFAULT_CONFIG, ...(section ?? {}) }
    this.configured = true

    // Listening follows the enabled flag: a disabled module holds no listener at
    // all, rather than holding one that declines to act. Both calls are
    // synchronous, so this stays inside updateConfiguration.
    if (this.config.enabled) {
      this.startListeningForVisits()
    } else {
      this.stopListeningForVisits()
    }

    if (this.config.enabled && (this.config.tab_opener_edges || this.internalPages.isWanted())) {
      this.startListeningForOpenersAndPages()
    } else {
      this.stopListeningForOpenersAndPages()
    }

    if (this.config.enabled && this.config.tab_link_tolerance_ms > 0) {
      this.startListeningForTabFields()
    } else {
      this.stopListeningForTabFields()
    }
  }

  /** Discard what is already stored when the configuration now in force disables the module. */
  async reconcileStore(): Promise<void> {
    if (!this.config.enabled) {
      const discarded = await this.visitStore.clear() + await this.openerStore.clear()
        + await this.pageStore.clear()
      await this.tabLinker.clear()

      if (discarded > 0) {
        console.log(`[rex-browsing] Disabled; discarded ${discarded} stored record(s).`)
      }
    }
  }

  private startListeningForVisits(): void {
    if (this.visitListener !== null) {
      return
    }

    this.visitListener = (item: chrome.history.HistoryItem) => {
      this.captureVisit(item).catch((error) => {
        console.error('[rex-browsing] Capture failed:', error)
      })
    }

    chrome.history.onVisited.addListener(this.visitListener)
  }

  private stopListeningForVisits(): void {
    if (this.visitListener === null) {
      return
    }

    chrome.history.onVisited.removeListener(this.visitListener)
    this.visitListener = null
  }

  /** True while a history listener is registered. Readable for diagnostics. */
  isListeningForVisits(): boolean {
    return this.visitListener !== null
  }

  private startListeningForOpenersAndPages(): void {
    if (this.openerAndPageListeners !== null || typeof chrome.tabs?.onCreated?.addListener !== 'function') {
      return
    }

    this.openerAndPageListeners = {
      created: (tab) => {
        if (this.config.tab_opener_edges) {
          this.tabOpeners.tabCreated(tab)
        }
      },
      updated: (tabId, changeInfo) => {
        // onUpdated fires for every status change of every tab; only a committed
        // URL is of interest, for a tab this module is holding or a page Chrome
        // keeps out of history.
        if (changeInfo.url === undefined) {
          return
        }

        this.tabOpeners.tabNavigated(tabId, changeInfo.url).catch((error) => {
          console.error('[rex-browsing] Opener capture failed:', error)
        })

        this.captureInternalPage(tabId, changeInfo.url).catch((error) => {
          console.error('[rex-browsing] Internal page capture failed:', error)
        })
      },
      removed: (tabId) => {
        this.tabOpeners.tabRemoved(tabId)
      }
    }

    chrome.tabs.onCreated.addListener(this.openerAndPageListeners.created)
    chrome.tabs.onUpdated.addListener(this.openerAndPageListeners.updated)
    chrome.tabs.onRemoved.addListener(this.openerAndPageListeners.removed)
  }

  private stopListeningForOpenersAndPages(): void {
    if (this.openerAndPageListeners === null) {
      return
    }

    chrome.tabs.onCreated.removeListener(this.openerAndPageListeners.created)
    chrome.tabs.onUpdated.removeListener(this.openerAndPageListeners.updated)
    chrome.tabs.onRemoved.removeListener(this.openerAndPageListeners.removed)
    this.openerAndPageListeners = null
    this.tabOpeners.forgetAll()
  }

  /** True while the tabs listeners are registered. Readable for diagnostics. */
  isListeningForOpenersAndPages(): boolean {
    return this.openerAndPageListeners !== null
  }

  private startListeningForTabFields(): void {
    if (this.tabFieldListener !== null || typeof chrome.webNavigation?.onCommitted?.addListener !== 'function') {
      return
    }

    this.tabFieldListener = (details) => {
      this.captureNavigation(details).catch((error) => {
        console.error('[rex-browsing] Navigation capture failed:', error)
      })
    }

    chrome.webNavigation.onBeforeNavigate.addListener(this.tabFieldListener)
    chrome.webNavigation.onCommitted.addListener(this.tabFieldListener)
    chrome.webNavigation.onHistoryStateUpdated.addListener(this.tabFieldListener)
    chrome.webNavigation.onReferenceFragmentUpdated.addListener(this.tabFieldListener)
  }

  private stopListeningForTabFields(): void {
    if (this.tabFieldListener === null) {
      return
    }

    chrome.webNavigation.onBeforeNavigate.removeListener(this.tabFieldListener)
    chrome.webNavigation.onCommitted.removeListener(this.tabFieldListener)
    chrome.webNavigation.onHistoryStateUpdated.removeListener(this.tabFieldListener)
    chrome.webNavigation.onReferenceFragmentUpdated.removeListener(this.tabFieldListener)
    this.tabFieldListener = null
  }

  /** True while the webNavigation listeners are registered. Readable for diagnostics. */
  isListeningForTabFields(): boolean {
    return this.tabFieldListener !== null
  }

  async captureVisit(item: chrome.history.HistoryItem): Promise<boolean> {
    // Checked here as well as by removing the listener, deliberately: two
    // independent guards, and the failure direction of each is to collect
    // nothing.
    if (!this.isAccepting() || item.url === undefined || !isRecordedScheme(item.url)) {
      return false
    }

    const record = await this.recordVisit(item.url, item.title ?? '', item.lastVisitTime, item.visitCount)

    // The visit is stored at this point, so a link failure is not a capture failure.
    try {
      await this.tabLinker.linkVisit(record)
    } catch (error) {
      console.error('[rex-browsing] Tab link failed:', error)
    }

    return true
  }

  /**
   * Keyed by visit id, so capturing the same visit twice writes the same record
   * rather than a duplicate. A visit whose ids cannot be had is still recorded.
   * `visitCount` already includes the visit being recorded.
   */
  private async recordVisit(url: string, title: string, lastVisitTime: number | undefined,
    visitCount: number | undefined): Promise<VisitRecord> {
    const visitTime = lastVisitTime ?? Date.now()

    if (this.isOverCeiling(visitCount)) {
      return this.visitStore.recordWithoutIds(url, title, visitTime, 'over_ceiling', this.config.max_visits_per_url)
    }

    const visit = await newestVisit(url, lastVisitTime)

    if (visit === null) {
      return this.visitStore.recordWithoutIds(url, title, visitTime, 'lookup_failed')
    }

    return this.visitStore.record(visit)
  }

  private isOverCeiling(visitCount: number | undefined): boolean {
    const ceiling = this.config.max_visits_per_url

    return ceiling > 0 && visitCount !== undefined && visitCount > ceiling
  }

  /** A tab committed a URL Chrome may keep out of history. */
  async captureInternalPage(tabId: number, url: string): Promise<boolean> {
    if (!this.isAccepting()) {
      return false
    }

    return this.internalPages.pageCommitted(tabId, url)
  }

  /**
   * A main-frame navigation event of a tab. Held until a visit to the same
   * URL near its time is, or has been, recorded.
   */
  async captureNavigation(details: { tabId: number, url: string, frameId: number, timeStamp: number }): Promise<boolean> {
    if (!this.isAccepting() || this.config.tab_link_tolerance_ms <= 0 || details.frameId !== 0
      || details.tabId < 0 || !isRecordedScheme(details.url)) {
      return false
    }

    const windowId = await this.windowOf(details.tabId)

    await this.tabLinker.acceptNavigation({
      url: details.url,
      tab_id: details.tabId,
      ...(windowId === undefined ? {} : { window_id: windowId }),
      time: details.timeStamp
    })

    return true
  }

  private async windowOf(tabId: number): Promise<number | undefined> {
    try {
      return (await chrome.tabs.get(tabId)).windowId
    } catch {
      return undefined
    }
  }

  private isAccepting(): boolean {
    return this.configured && this.config.enabled
  }

  /**
   * `triggerBrowsingDrain` emits any stored records now and responds with the
   * count, so a host extension can drain on its own cadence rather than waiting
   * for the alarm.
   */
  override handleMessage(
    message: { messageType?: string, event?: unknown } | undefined,
    _sender: unknown,
    sendResponse: (response: unknown) => void
  ): boolean {
    if (message?.messageType !== 'triggerBrowsingDrain') {
      return false
    }

    this.drain()
      .then((count) => sendResponse(count))
      .catch(() => sendResponse(0))

    return true
  }

  async drain(): Promise<number> {
    if (this.draining) {
      return 0
    }

    this.draining = true
    const now = Date.now()

    try {
      // Sweep first and unconditionally, so a record past its age is discarded
      // rather than held without bound while the module is unconfigured,
      // disabled, or waiting on an identifier.
      await this.sweepExpired(now)

      // A host drains on its own cadence, so being switched off has to stop
      // emission here rather than only stopping the alarm being scheduled.
      if (!this.config.enabled) {
        return 0
      }

      // Records wait for the participant to exist, so nothing is emitted unattributed.
      if (!(await this.hasIdentifier())) {
        return 0
      }

      const visits = await this.visitStore.readAll()
      const emittable = visits.filter((visit) => visit.visit_time <= now - this.config.tab_link_tolerance_ms)
      const openers = await this.openerStore.readAll()
      const pages = await this.pageStore.readAll()

      const emittedVisitIds = await this.emitVisits(emittable)

      await this.emitCeilingEvents(emittable, now)

      const emittedOpenerIds = this.emitOpeners(openers, visits)
      const emittedPageIds = this.emitPages(pages)

      // Emit, then forget. A worker killed between the two re-emits next cycle;
      // killed in the other order, the visit is gone. A duplicate is recoverable
      // in analysis, a loss is not.
      if (emittedVisitIds.length > 0) {
        await this.visitStore.forget(emittedVisitIds)
      }

      if (emittedOpenerIds.length > 0) {
        await this.openerStore.forget(emittedOpenerIds)
      }

      if (emittedPageIds.length > 0) {
        await this.pageStore.forget(emittedPageIds)
      }

      return emittedVisitIds.length + emittedOpenerIds.length + emittedPageIds.length
    } catch (error) {
      console.error('[rex-browsing] Drain failed:', error)
      return 0
    } finally {
      this.draining = false
    }
  }

  private async sweepExpired(nowMs: number): Promise<void> {
    const cutoff = nowMs - (this.config.max_record_age_days * 24 * 60 * 60 * 1000)
    await this.visitStore.sweep(cutoff)
    await this.openerStore.sweep(cutoff)
    await this.pageStore.sweep(cutoff)
  }

  private async emitVisits(visits: VisitRecord[]): Promise<string[]> {
    const emittedVisitIds: string[] = []

    for (const visit of visits) {
      // Read at drain rather than at visit time, because onVisited often fires
      // before the page's title is known.
      const item = await historyItemFields(visit.url, visit.visit_time)
      let event: BrowsingVisitEvent

      if (visit.ids_unavailable === undefined) {
        event = identifiedVisitEvent(visit, item)
      } else {
        event = visitWithoutIdsEvent(visit, item)
      }

      dispatchEvent(event)

      emittedVisitIds.push(storageIdOf(visit))
    }

    return emittedVisitIds
  }

  private emitOpeners(openers: OpenerRecord[], visits: VisitRecord[]): string[] {
    const emittedOpenerIds: string[] = []

    // Resolved against the visits read in this same drain, so a redirect chain
    // in the new tab attaches the edge to its root rather than its landing.
    for (const opener of openers) {
      const root = chainRoot(opener, visits)

      dispatchEvent({
        name: 'rex-browsing-opener',
        visit_id: root.visit_id,
        referring_visit_id: opener.opener_visit_id,
        visit_time: root.visit_time,
        transition: opener.transition,
        date: root.visit_time,
        url: root.url
      })

      emittedOpenerIds.push(opener.visit_id)
    }

    return emittedOpenerIds
  }

  private emitPages(pages: PageRecord[]): string[] {
    const emittedPageIds: string[] = []

    for (const page of pages) {
      dispatchEvent({
        name: 'rex-browsing-page',
        visit_time: page.visit_time,
        tab_id: page.tab_id,
        date: page.visit_time,
        url: page.url
      })

      emittedPageIds.push(page.page_id)
    }

    return emittedPageIds
  }

  /** One event per URL whose visits in this drain went over the ceiling, mirroring rex-history's. */
  private async emitCeilingEvents(records: VisitRecord[], now: number): Promise<void> {
    const overByUrl = new Map<string, { visitTime: number; ceiling: number | undefined; count: number }>()

    for (const record of records) {
      if (record.ids_unavailable === 'over_ceiling') {
        const seen = overByUrl.get(record.url)
        const count = (seen?.count ?? 0) + 1

        // The earliest visit's ceiling, since that is when the address went over it.
        if (seen === undefined || record.visit_time < seen.visitTime) {
          overByUrl.set(record.url, { visitTime: record.visit_time, ceiling: record.ceiling, count })
        } else {
          seen.count = count
        }
      }
    }

    for (const [url, over] of overByUrl) {
      const item = await historyItemFields(url, over.visitTime)

      dispatchEvent({
        name: 'pdk-app-event',
        event_name: 'rex-browsing-visit-ceiling-exceeded',
        event_details: {
          domain: registeredDomain(url),
          ...(item?.visit_count === undefined ? {} : { visit_count: item.visit_count }),
          ...(over.ceiling === undefined ? {} : { ceiling: over.ceiling }),
          visits_in_drain: over.count,
          date: now
        }
      })
    }
  }

  /** The identifier belongs to rex-core; an empty or absent one means the participant has none yet. */
  private async hasIdentifier(): Promise<boolean> {
    return new Promise((resolve) => {
      rexCorePlugin.handleMessage({ messageType: 'getIdentifier' }, null, (response) => {
        resolve(typeof response === 'string' && response !== '')
      })
    })
  }

  currentConfig(): BrowsingConfig {
    return this.config
  }

  /**
   * Test seam: simulates a WORKER RESTART, which clears in-memory state and
   * leaves chrome.storage untouched. Clearing the store here would assert
   * something that never happens.
   */
  simulateWorkerRestart(): void {
    this.draining = false
  }

  /** Test seam: the state of a worker that has not yet read configuration. */
  simulateBeforeConfiguration(): void {
    this.configured = false
    this.config = DEFAULT_CONFIG
    this.stopListeningForVisits()
    this.stopListeningForOpenersAndPages()
    this.stopListeningForTabFields()
  }

  /**
   * Test seam: a worker killed mid-drain leaves the guard set in the instance
   * that died. It resets on restart on its own, because `draining` is a plain
   * field and is never persisted; this exists to prove that.
   */
  simulateDrainInterrupted(value: boolean): void {
    this.draining = value
  }
}

const plugin = new BrowsingServiceWorkerModule()

registerREXModule(plugin)

export default plugin
