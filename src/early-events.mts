import { isMainFrame, isUrlChange, type NavigationDetails, type TabChange } from './browser-events.mjs'

const MAX_HELD_EVENTS = 200

type VisitListener = (item: chrome.history.HistoryItem) => void
type NavigationListener = (details: NavigationDetails) => void
type TabCreatedListener = (tab: chrome.tabs.Tab) => void
type TabUpdatedListener = (tabId: number, changeInfo: TabChange) => void

export interface EarlyEventTargets {
  visit: VisitListener | null;
  navigation: NavigationListener | null;
  openerAndPage: { created: TabCreatedListener; updated: TabUpdatedListener } | null;
}

type HeldEvent =
  | { kind: 'visit'; item: chrome.history.HistoryItem }
  | { kind: 'navigation'; details: NavigationDetails }
  | { kind: 'tabCreated'; tab: chrome.tabs.Tab }
  | { kind: 'tabUpdated'; tabId: number; changeInfo: TabChange }

/**
 * Chrome delivers the event that woke a stopped service worker only to listeners
 * registered while the worker's script first runs. The module's own listeners wait for
 * configuration, so this holds what arrives in that gap and replays it to them.
 */
export class EarlyEventBuffer {
  private held: HeldEvent[] = []

  private listening = false

  private readonly onVisited: VisitListener = (item) => this.hold({ kind: 'visit', item })

  private navigationRegistered = false

  private readonly onNavigation: NavigationListener = (details) => {
    if (this.listening && isMainFrame(details)) {
      this.hold({ kind: 'navigation', details })
    }
  }

  private readonly onTabCreated: TabCreatedListener = (tab) => this.hold({ kind: 'tabCreated', tab })

  private readonly onTabUpdated: TabUpdatedListener = (tabId, changeInfo) => {
    if (isUrlChange(changeInfo)) {
      this.hold({ kind: 'tabUpdated', tabId, changeInfo })
    }
  }

  start(): void {
    if (this.listening) {
      return
    }

    this.listening = true
    chrome.history?.onVisited?.addListener(this.onVisited)
    chrome.tabs?.onCreated?.addListener(this.onTabCreated)
    chrome.tabs?.onUpdated?.addListener(this.onTabUpdated)
    this.registerNavigationListeners()
  }

  release(targets: EarlyEventTargets): void {
    this.stop()

    const events = this.held
    this.held = []

    events.forEach((event) => this.replay(event, targets))
  }

  isListening(): boolean {
    return this.listening
  }

  heldCount(): number {
    return this.held.length
  }

  private stop(): void {
    if (!this.listening) {
      return
    }

    this.listening = false
    chrome.history?.onVisited?.removeListener(this.onVisited)
    chrome.tabs?.onCreated?.removeListener(this.onTabCreated)
    chrome.tabs?.onUpdated?.removeListener(this.onTabUpdated)
  }

  private registerNavigationListeners(): void {
    if (this.navigationRegistered) {
      return
    }

    this.navigationRegistered = true
    chrome.webNavigation?.onBeforeNavigate?.addListener(this.onNavigation)
    chrome.webNavigation?.onCommitted?.addListener(this.onNavigation)
    chrome.webNavigation?.onHistoryStateUpdated?.addListener(this.onNavigation)
    chrome.webNavigation?.onReferenceFragmentUpdated?.addListener(this.onNavigation)
  }

  private hold(event: HeldEvent): void {
    this.held.push(event)

    if (this.held.length > MAX_HELD_EVENTS) {
      this.held.shift()
    }
  }

  private replay(event: HeldEvent, targets: EarlyEventTargets): void {
    if (event.kind === 'visit') {
      targets.visit?.(event.item)
    } else if (event.kind === 'navigation') {
      targets.navigation?.(event.details)
    } else if (event.kind === 'tabCreated') {
      targets.openerAndPage?.created(event.tab)
    } else {
      targets.openerAndPage?.updated(event.tabId, event.changeInfo)
    }
  }
}
