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
import { VisitStore } from './visit-store.mjs'
import { historyItemFields, registeredDomain } from './history-item.mjs'
import { OpenerStore, TabOpenerTracker, chainRoot } from './tab-opener.mjs'
import { InternalPageRecorder, PageStore } from './internal-pages.mjs'
import { TabLinker, isUrlActiveRecord } from './tab-link.mjs'

export interface BrowsingConfig {
  enabled: boolean;
  /** Match window for linking a visit to a url-active record. 0 disables linking. */
  page_events_link_tolerance_ms: number;
  /**
   * Whether a new tab's first visit is attributed to the page that opened it.
   * Chrome records no referrer across a tab boundary; see tab-opener.mts.
   */
  tab_opener_edges: boolean;
  /**
   * Ceiling on an opener page's visit count, above which it is not looked up.
   *
   * `getVisits()` takes no time range and no limit, so its cost scales with how
   * many visits a URL has ever had. A page that re-records a visit every few
   * seconds reaches a size where resolving it costs about a second, and the
   * opener path pays that on every new tab. Non-positive disables the ceiling.
   */
  max_opener_visits: number;
  /** Records the browser's own pages, which Chrome keeps out of history. */
  internal_pages: boolean;
  max_record_age_days: number;
}

const DEFAULT_CONFIG: BrowsingConfig = {
  enabled: false,
  page_events_link_tolerance_ms: 5000,
  tab_opener_edges: true,
  // Chosen from the measured cost, which scales with the count: 440,000 visits
  // resolve in ~1075ms, so ~2.4us each, and 25,000 is about 60ms. Above any
  // organic page — visiting one 20 times a day for three years is ~22,000 — and
  // reached in under a day by a page that re-records every few seconds. It is a
  // judgement, not a finding, which is why it is server config.
  max_opener_visits: 25_000,
  internal_pages: false,
  max_record_age_days: 7
}

class BrowsingServiceWorkerModule extends REXServiceWorkerModule {
  readonly visitStore = new VisitStore()
  readonly tabLinker = new TabLinker(this.visitStore, () => this.config.page_events_link_tolerance_ms)
  readonly openerStore = new OpenerStore()
  readonly tabOpeners = new TabOpenerTracker({
    store: this.openerStore,
    maxOpenerVisits: () => this.config.max_opener_visits
  })
  readonly pageStore = new PageStore()
  readonly internalPages = new InternalPageRecorder({
    store: this.pageStore,
    wanted: () => this.config.internal_pages
  })

  private config: BrowsingConfig = DEFAULT_CONFIG

  /** In-memory, never persisted: a fresh worker restarts with it clear. */
  private draining = false

  /** False until the first updateConfiguration, so a visit before it is held rather than refused. */
  private configured = false

  /** Held so it can be removed again; a listener is only removable by reference. */
  private historyListener: ((item: chrome.history.HistoryItem) => void) | null = null

  private tabListeners: {
    created: (tab: chrome.tabs.Tab) => void;
    updated: (tabId: number, changeInfo: { url?: string }) => void;
    removed: (tabId: number) => void;
  } | null = null

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
          + 'Visits that happen before configuration is read are held, then kept or discarded by this flag.',
        page_events_link_tolerance_ms: 'Number, default 5000. A visit is linked to the tab it happened in '
          + 'from a rex-page-events url-active record with the same URL shown within this many '
          + 'milliseconds of the visit; the newest such record wins. 0 disables linking.',
        tab_opener_edges: 'Boolean, default true. Attributes the first visit in a new tab to the page '
          + 'that opened it, emitted as rex-browsing-opener points. Chrome records no referrer across '
          + 'a tab boundary, so without this a result opened in a new tab arrives from nowhere. Needs the '
          + 'tabs permission in the host; without it nothing is recorded.',
        max_opener_visits: 'Number, default 25000. A page with more visits than this is not looked '
          + 'up when it opens a tab, so no opener edge is recorded for tabs it opens. getVisits() '
          + 'cannot be bounded and costs about a second on a page that re-records a visit every few '
          + 'seconds, charged per new tab. Raise it to keep attribution on a heavily revisited page, '
          + 'lower it if lookups are still costing participants, 0 to remove the ceiling entirely.',
        internal_pages: 'Boolean, default false. Records the browser\'s own pages (chrome://, '
          + 'chrome-untrusted://, edge://), which Chrome keeps out of history, as rex-browsing-page '
          + 'points with no visit ids. These addresses can carry text the participant typed. Needs '
          + 'the tabs permission.',
        max_record_age_days: 'Number, default 7. Days after which a record that was never emitted is discarded.'
      }
    }
  }

  currentConfig(): BrowsingConfig {
    return this.config
  }

  async captureVisit(item: chrome.history.HistoryItem): Promise<boolean> {
    // Checked here as well as by removing the listener, deliberately: two
    // independent guards, and the failure direction of each is to collect
    // nothing.
    if (!this.isAccepting() || item.url === undefined || !isRecordedScheme(item.url)) {
      return false
    }

    // Keyed by visit id, so capturing the same visit twice writes the same
    // record rather than a duplicate.
    const visit = await newestVisit(item.url)

    if (visit === null) {
      return false
    }

    await this.tabLinker.linkVisit(await this.visitStore.record(visit))
    return true
  }

  /** A tab committed a URL Chrome may keep out of history. */
  async captureInternalPage(tabId: number, url: string): Promise<boolean> {
    if (!this.isAccepting()) {
      return false
    }

    return this.internalPages.pageCommitted(tabId, url)
  }

  /**
   * Before configuration arrives the module cannot know whether the study wants
   * it, and a visit not captured while it happens is unrecoverable, so it
   * accepts; reconcileStore then discards what a disabled study should not have.
   */
  private isAccepting(): boolean {
    return !this.configured || this.config.enabled
  }

  /** The identifier belongs to rex-core; an empty or absent one means the participant has none yet. */
  async hasIdentifier(): Promise<boolean> {
    return new Promise((resolve) => {
      rexCorePlugin.handleMessage({ messageType: 'getIdentifier' }, null, (response) => {
        resolve(typeof response === 'string' && response !== '')
      })
    })
  }

  async drain(): Promise<number> {
    if (this.draining) {
      return 0
    }

    this.draining = true

    try {
      // Sweep first and unconditionally, so a record past its age is discarded
      // rather than held without bound while the module is unconfigured,
      // disabled, or waiting on an identifier.
      const cutoff = Date.now() - (this.config.max_record_age_days * 24 * 60 * 60 * 1000)
      await this.visitStore.sweep(cutoff)
      await this.openerStore.sweep(cutoff)
      await this.pageStore.sweep(cutoff)

      // A host drains on its own cadence, so being switched off has to stop
      // emission here rather than only stopping the alarm being scheduled.
      if (!this.config.enabled) {
        return 0
      }

      // Records wait for the participant to exist, so nothing is emitted unattributed.
      if (!(await this.hasIdentifier())) {
        return 0
      }

      const records = await this.visitStore.readAll()
      const openers = await this.openerStore.readAll()
      const pages = await this.pageStore.readAll()
      const emitted: string[] = []
      const emittedOpeners: string[] = []
      const emittedPages: string[] = []

      for (const record of records) {
        // Read at drain rather than at visit time, because onVisited often fires
        // before the page's title is known.
        const item = await historyItemFields(record.url)

        dispatchEvent({
          name: 'rex-browsing-visit',
          url: record.url,
          recorded_url: record.url,
          domain: registeredDomain(record.url),
          visit_time: record.visit_time,
          transition_type: record.transition_type,
          is_local: record.is_local,
          date: record.visit_time,
          visit_id: record.visit_id,
          referring_visit_id: record.referring_visit_id,
          ...(item ?? { title: '' }),
          ...(record.link ?? {})
        })

        emitted.push(record.visit_id)
      }

      // Resolved against the visits read in this same drain, so a redirect chain
      // in the new tab attaches the edge to its root rather than its landing.
      for (const record of openers) {
        const root = chainRoot(record, records)

        dispatchEvent({
          name: 'rex-browsing-opener',
          visit_id: root.visit_id,
          referring_visit_id: record.opener_visit_id,
          visit_time: root.visit_time,
          transition: record.transition,
          date: root.visit_time,
          url: root.url
        })

        emittedOpeners.push(record.visit_id)
      }

      for (const record of pages) {
        dispatchEvent({
          name: 'rex-browsing-page',
          visit_time: record.visit_time,
          tab_id: record.tab_id,
          date: record.visit_time,
          url: record.url
        })

        emittedPages.push(record.page_id)
      }

      // Emit, then forget. A worker killed between the two re-emits next cycle;
      // killed in the other order, the visit is gone. A duplicate is recoverable
      // in analysis, a loss is not.
      if (emitted.length > 0) {
        await this.visitStore.forget(emitted)
      }

      if (emittedOpeners.length > 0) {
        await this.openerStore.forget(emittedOpeners)
      }

      if (emittedPages.length > 0) {
        await this.pageStore.forget(emittedPages)
      }

      return emitted.length + emittedOpeners.length + emittedPages.length
    } catch (error) {
      console.error('[rex-browsing] Drain failed:', error)
      return 0
    } finally {
      this.draining = false
    }
  }

  /**
   * `triggerBrowsingDrain` emits any stored records now and responds with the
   * count, so a host extension can drain on its own cadence rather than waiting
   * for the alarm. `pageUrlActive` carries a rex-page-events url-active record,
   * which links visits to the tab they happened in.
   */
  override handleMessage(
    message: { messageType?: string, event?: unknown } | undefined,
    _sender: unknown,
    sendResponse: (response: unknown) => void
  ): boolean {
    if (message?.messageType === 'pageUrlActive') {
      return this.handleUrlActive(message.event, sendResponse)
    }

    if (message?.messageType !== 'triggerBrowsingDrain') {
      return false
    }

    this.drain()
      .then((count) => sendResponse(count))
      .catch(() => sendResponse(0))

    return true
  }

  private handleUrlActive(event: unknown, sendResponse: (response: unknown) => void): boolean {
    if (!this.isAccepting()) {
      return false
    }

    if (!isUrlActiveRecord(event)) {
      console.warn('[rex-browsing] Ignoring malformed pageUrlActive record:', event)
      return false
    }

    this.tabLinker.acceptUrlActive(event)
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        console.error('[rex-browsing] Url-active record failed:', error)
        sendResponse({ success: false })
      })

    return true
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
  }

  /**
   * Test seam: a worker killed mid-drain leaves the guard set in the instance
   * that died. It resets on restart on its own, because `draining` is a plain
   * field and is never persisted; this exists to prove that.
   */
  simulateDrainInterrupted(value: boolean): void {
    this.draining = value
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
      this.startListening()
    } else {
      this.stopListening()
    }

    if (this.config.enabled && (this.config.tab_opener_edges || this.internalPages.isWanted())) {
      this.startListeningForTabs()
    } else {
      this.stopListeningForTabs()
    }
  }

  /** True while a history listener is registered. Readable for diagnostics. */
  isListening(): boolean {
    return this.historyListener !== null
  }

  /** True while the tabs listeners are registered. Readable for diagnostics. */
  isListeningForTabs(): boolean {
    return this.tabListeners !== null
  }

  private startListeningForTabs(): void {
    if (this.tabListeners !== null || typeof chrome.tabs?.onCreated?.addListener !== 'function') {
      return
    }

    this.tabListeners = {
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

    chrome.tabs.onCreated.addListener(this.tabListeners.created)
    chrome.tabs.onUpdated.addListener(this.tabListeners.updated)
    chrome.tabs.onRemoved.addListener(this.tabListeners.removed)
  }

  private stopListeningForTabs(): void {
    if (this.tabListeners === null) {
      return
    }

    chrome.tabs.onCreated.removeListener(this.tabListeners.created)
    chrome.tabs.onUpdated.removeListener(this.tabListeners.updated)
    chrome.tabs.onRemoved.removeListener(this.tabListeners.removed)
    this.tabListeners = null
    this.tabOpeners.forgetAll()
  }

  private startListening(): void {
    if (this.historyListener !== null) {
      return
    }

    this.historyListener = (item: chrome.history.HistoryItem) => {
      this.captureVisit(item).catch((error) => {
        console.error('[rex-browsing] Capture failed:', error)
      })
    }

    chrome.history.onVisited.addListener(this.historyListener)
  }

  private stopListening(): void {
    if (this.historyListener === null) {
      return
    }

    chrome.history.onVisited.removeListener(this.historyListener)
    this.historyListener = null
  }

  /** Discard what is already stored when the configuration now in force disables the module. */
  async reconcileStore(): Promise<void> {
    if (!this.config.enabled) {
      const discarded = await this.visitStore.clear() + await this.openerStore.clear()
        + await this.pageStore.clear()
      await this.tabLinker.clear()

      if (discarded > 0) {
        console.log(`[rex-browsing] Disabled; discarded ${discarded} edge(s) captured before configuration.`)
      }
    }
  }

  /** rex-core's activation hook: fetch, then hand this module's own section over. */
  async refreshConfiguration(): Promise<void> {
    try {
      const all = await rexCorePlugin.fetchConfiguration() as Record<string, unknown> | undefined

      this.updateConfiguration(all?.['browsing'] as Partial<BrowsingConfig> | undefined)

      await this.reconcileStore()
    } catch (error) {
      console.error('[rex-browsing] Failed to load configuration:', error)
    }
  }

  async setup(): Promise<void> {
    console.log('[rex-browsing/service-worker] Setting up visit graph capture')

    // Listen before configuration is fetched, because the module defaults to
    // enabled and onVisited fires once: a visit missed while the fetch is in
    // flight is unrecoverable. refreshConfiguration then removes the listener
    // again if the study has the module turned off, so a disabled module ends up
    // holding no listener and having emitted nothing.
    this.startListening()
    this.startListeningForTabs()

    await this.refreshConfiguration()
  }
}

const plugin = new BrowsingServiceWorkerModule()

registerREXModule(plugin)

export default plugin
