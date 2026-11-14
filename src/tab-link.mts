/**
 * Links a visit to the tab it happened in, from main-frame navigations the
 * module holds.
 *
 * A visit and its navigation arrive in either order, and a service worker can
 * restart between the two, so both wait in storage: visits in the visit store,
 * navigations in chrome.storage.session.
 */

import { storageIdOf, type TabLink, type VisitRecord, type VisitStore } from './visit-store.mjs'

const STORAGE_KEY = 'rexBrowsingTabNavigation'

const MAX_HELD = 256

export interface TabNavigation {
  url: string;
  tab_id: number;
  window_id?: number;
  time: number;
}

function linkFrom(navigation: TabNavigation): TabLink {
  return {
    tab_id: navigation.tab_id,
    ...(navigation.window_id === undefined ? {} : { window_id: navigation.window_id }),
    navigation_time: navigation.time
  }
}

function newest(navigations: TabNavigation[]): TabNavigation {
  return navigations.reduce((latest, navigation) => (navigation.time >= latest.time ? navigation : latest))
}

export class TabLinker {
  /**
   * Held navigations are one storage value, so writes are queued: two events
   * read-modify-writing it at once would each drop the other's navigation.
   */
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly store: VisitStore, private readonly tolerance: () => number) {}

  async acceptNavigation(navigation: TabNavigation): Promise<void> {
    const stored = this.writes.then(async () => {
      const held = await this.readHeld()

      held.push(navigation)
      await chrome.storage.session.set({ [STORAGE_KEY]: held.slice(-MAX_HELD) })
    })

    this.writes = stored.catch(() => undefined)
    await stored

    for (const visit of await this.store.readAll()) {
      if (this.matches(visit, navigation)) {
        await this.store.attachLink(storageIdOf(visit), linkFrom(navigation))
      }
    }
  }

  async linkVisit(visit: VisitRecord): Promise<void> {
    const matching = (await this.readHeld()).filter((navigation) => this.matches(visit, navigation))

    if (matching.length > 0) {
      await this.store.attachLink(storageIdOf(visit), linkFrom(newest(matching)))
    }
  }

  /** Discard every held navigation. Used when the module is turned off. */
  async clear(): Promise<void> {
    await chrome.storage.session.remove(STORAGE_KEY)
  }

  private matches(visit: VisitRecord, navigation: TabNavigation): boolean {
    const tolerance = this.tolerance()

    return tolerance > 0
      && visit.url === navigation.url
      && Math.abs(visit.visit_time - navigation.time) <= tolerance
  }

  private async readHeld(): Promise<TabNavigation[]> {
    const stored = await chrome.storage.session.get(STORAGE_KEY)
    const held = stored[STORAGE_KEY]

    return Array.isArray(held) ? held : []
  }
}
