const MAX_HELD_EVENTS = 200

export interface NavigationDetails {
  tabId: number;
  url: string;
  frameId: number;
  timeStamp: number;
}

type VisitListener = (item: chrome.history.HistoryItem) => void
type NavigationListener = (details: NavigationDetails) => void
type TabCreatedListener = (tab: chrome.tabs.Tab) => void
type TabUpdatedListener = (tabId: number, changeInfo: { url?: string }) => void

export interface EarlyEventTargets {
  visit: VisitListener | null;
  navigation: NavigationListener | null;
  openerAndPage: { created: TabCreatedListener; updated: TabUpdatedListener } | null;
}

type HeldEvent =
  | { kind: 'visit'; item: chrome.history.HistoryItem }
  | { kind: 'navigation'; details: NavigationDetails }
  | { kind: 'tabCreated'; tab: chrome.tabs.Tab }
  | { kind: 'tabUpdated'; tabId: number; changeInfo: { url?: string } }

/**
 * Chrome delivers the event that woke a stopped service worker only to listeners
 * registered while the worker's script first runs. The module's own listeners wait for
 * configuration, so this holds what arrives in that gap and replays it to them.
 */
export class EarlyEventBuffer {
  private held: HeldEvent[] = []

  private listening = false

  private readonly onVisited: VisitListener = (item) => this.hold({ kind: 'visit', item })

  private readonly onNavigation: NavigationListener = (details) => this.hold({ kind: 'navigation', details })

  private readonly onTabCreated: TabCreatedListener = (tab) => this.hold({ kind: 'tabCreated', tab })

  private readonly onTabUpdated: TabUpdatedListener = (tabId, changeInfo) => this.hold({ kind: 'tabUpdated', tabId, changeInfo })

  start(): void {
    if (this.listening) {
      return
    }

    this.listening = true
    chrome.history?.onVisited?.addListener(this.onVisited)
    chrome.tabs?.onCreated?.addListener(this.onTabCreated)
    chrome.tabs?.onUpdated?.addListener(this.onTabUpdated)
    this.navigationEvents().forEach((event) => event?.addListener(this.onNavigation))
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
    this.navigationEvents().forEach((event) => event?.removeListener(this.onNavigation))
  }

  private navigationEvents(): Array<chrome.events.Event<NavigationListener> | undefined> {
    const navigation = chrome.webNavigation as unknown as Record<string, chrome.events.Event<NavigationListener>> | undefined

    return [
      navigation?.onBeforeNavigate,
      navigation?.onCommitted,
      navigation?.onHistoryStateUpdated,
      navigation?.onReferenceFragmentUpdated
    ]
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
