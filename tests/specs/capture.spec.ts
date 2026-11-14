/**
 * Loads the module as a real Chrome extension with real chrome.history,
 * chrome.storage and chrome.alarms.
 *
 * Headless mode is off because Chrome's CDP bridge does not expose extension
 * service workers in headless: a window appears during the run on macOS and
 * Windows; wrap in Xvfb on Linux CI.
 */

import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))


test.describe('rex-browsing — real extension', () => {
  test.describe.configure({ mode: 'serial' })

  let context: BrowserContext
  let serviceWorker: Worker
  let userDataDir: string

  test.beforeAll(async () => {
    const extensionPath = path.join(__dirname, '../extension')
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-browsing-'))

    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        // Headed is not a choice: Chrome's CDP bridge does not expose extension
        // service workers in headless mode, so the specs cannot reach the module.
        // Parking the window off-screen keeps it out of the way of whoever is at
        // the keyboard; it still takes focus briefly on launch.
        '--window-position=-3000,-3000',
        '--window-size=800,600',
        // Gives the local server a name with a registered domain, which neither
        // "localhost" nor "127.0.0.1" has. example.com is IANA-reserved, so the
        // name cannot collide with anything real.
        '--host-resolver-rules=MAP dashboard.example.com 127.0.0.1'
      ]
    })

    serviceWorker = context.serviceWorkers()[0]
      ?? await context.waitForEvent('serviceworker', { timeout: 30_000 })
  })

  test.afterAll(async () => {
    await context?.close()
    if (userDataDir) {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  test.beforeEach(async () => {
    await serviceWorker.evaluate(async () => {
      const stored = await chrome.storage.local.get()
      const hopKeys = Object.keys(stored).filter((key) => key.startsWith('rexBrowsingVisit:'))
      if (hopKeys.length > 0) await chrome.storage.local.remove(hopKeys)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(self as any).__capturedEvents = []
    })
  })

  // -------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------

  test('stores a visit under its own key', async () => {
    const stored = await serviceWorker.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexBrowsingPlugin
      p.updateConfiguration({ enabled: true })
      const real = chrome.history.getVisits
      chrome.history.getVisits = async () => ([
        { id: '1', visitId: '5', referringVisitId: '4', visitTime: Date.now(), transition: 'link', isLocal: true }
      ]) as never
      try {
        await p.captureVisit({ id: '1', url: 'https://www.example.com/any/page?q=1' })
      } finally {
        chrome.history.getVisits = real
      }
      const all = await chrome.storage.local.get()
      return Object.keys(all).filter((key) => key.startsWith('rexBrowsingVisit:'))
    })

    expect(stored).toEqual(['rexBrowsingVisit:5'])
  })

  test('captures even when no configuration has loaded', async () => {
    const stored = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.remove('REXConfiguration')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexBrowsingPlugin
      const real = chrome.history.getVisits
      chrome.history.getVisits = async () => ([
        { id: '1', visitId: '5', referringVisitId: '4', visitTime: Date.now(), transition: 'link', isLocal: true }
      ]) as never
      try {
        await p.captureVisit({ id: '1', url: 'https://www.example.com/any/page' })
      } finally {
        chrome.history.getVisits = real
      }
      return await p.visitStore.readAll()
    })

    expect(stored).toHaveLength(1)
  })

  test('does not record non-http schemes as visits', async () => {
    const result = await serviceWorker.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexBrowsingPlugin
      p.updateConfiguration({ enabled: true })
      const real = chrome.history.getVisits
      let visitId = 0
      chrome.history.getVisits = async () => {
        visitId += 1
        return [{ id: '1', visitId: String(visitId), referringVisitId: '0', visitTime: Date.now(), transition: 'link', isLocal: true }] as never
      }
      try {
        return {
          data: await p.captureVisit({ id: '1', url: 'data:text/html,<p>hello</p>' }),
          file: await p.captureVisit({ id: '2', url: 'file:///Users/someone/private.pdf' }),
          extension: await p.captureVisit({ id: '3', url: 'chrome-extension://abc/page.html' }),
          http: await p.captureVisit({ id: '4', url: 'http://example.com/' }),
          https: await p.captureVisit({ id: '5', url: 'https://example.com/' }),
          stored: (await p.visitStore.readAll()).map((r: { url: string }) => r.url).sort()
        }
      } finally {
        chrome.history.getVisits = real
      }
    })

    expect(result.data).toBe(false)
    expect(result.file).toBe(false)
    expect(result.extension).toBe(false)
    // Positive control: the same stubbed lookup does record the web schemes.
    expect(result.http).toBe(true)
    expect(result.https).toBe(true)
    expect(result.stored).toEqual(['http://example.com/', 'https://example.com/'])
  })

  test('concurrent captures do not overwrite each other', async () => {
    const count = await serviceWorker.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexBrowsingPlugin
      const writes = []
      for (let index = 0; index < 20; index += 1) {
        writes.push(p.visitStore.record({
          url: `https://www.example.com/page${index}`,
          visitId: String(index),
          referringVisitId: String(index - 1),
          visitTime: Date.now() + index,
          transition: 'link',
          isLocal: true
        }))
      }
      await Promise.all(writes)
      return (await p.visitStore.readAll()).length
    })

    expect(count).toBe(20)
  })

  // -------------------------------------------------------------------------
  // Drain
  // -------------------------------------------------------------------------

  test('emits one point per stored visit and clears the store', async () => {
    const result = await serviceWorker.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexBrowsingPlugin
      p.updateConfiguration({ enabled: true })
      await p.visitStore.record({ url: 'https://www.example.com/a?q=1', visitId: '5', referringVisitId: '4', visitTime: Date.now(), transition: 'link', isLocal: true })
      await p.visitStore.record({ url: 'https://www.example.com/b', visitId: '9', referringVisitId: '8', visitTime: Date.now(), transition: 'typed', isLocal: false })

      const count = await p.drain()
      const remaining = await p.visitStore.readAll()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const events = (self as any).__capturedEvents.filter((e: any) => e.name === 'rex-browsing-visit')
      return { count, remaining: remaining.length, events }
    })

    expect(result.count).toBe(2)
    expect(result.remaining).toBe(0)
    expect(result.events).toHaveLength(2)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = result.events.find((e: any) => e.visit_id === '5')
    expect(first.referring_visit_id).toBe('4')
    expect(first.url).toBe('https://www.example.com/a?q=1')
    expect(first.recorded_url).toBe('https://www.example.com/a?q=1')
    expect(first.transition_type).toBe('link')
    expect(first.is_local).toBe(true)
    expect(first).not.toHaveProperty('capture_rule')
  })

  test('a visit stranded by a worker kill is emitted after restart', async () => {
    const emitted = await serviceWorker.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexBrowsingPlugin
      await p.visitStore.record({ url: 'https://www.example.com/a', visitId: '5', referringVisitId: '4', visitTime: Date.now(), transition: 'link', isLocal: true })

      // A worker killed mid-drain leaves the guard set in the dead instance. The
      // replacement reconstructs it clear, and the stored visit is still there.
      p.simulateDrainInterrupted(true)
      p.simulateWorkerRestart()

      return await p.drain()
    })

    expect(emitted).toBe(1)
  })

  test('a second drain during the first is refused, not queued', async () => {
    const counts = await serviceWorker.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexBrowsingPlugin
      await p.visitStore.record({ url: 'https://www.example.com/a', visitId: '5', referringVisitId: '4', visitTime: Date.now(), transition: 'link', isLocal: true })
      return await Promise.all([p.drain(), p.drain()])
    })

    expect(counts.filter((count) => count > 0)).toHaveLength(1)
    expect(counts).toContain(0)
  })

  test('sweep drops visits older than the cutoff', async () => {
    const remaining = await serviceWorker.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexBrowsingPlugin
      const old = Date.now() - 60_000
      await p.visitStore.record({ url: 'https://www.example.com/a', visitId: '1', referringVisitId: '0', visitTime: old, transition: 'link', isLocal: true })
      await p.visitStore.record({ url: 'https://www.example.com/b', visitId: '2', referringVisitId: '1', visitTime: Date.now(), transition: 'link', isLocal: true })
      await p.visitStore.sweep(Date.now() - 30_000)
      return (await p.visitStore.readAll()).map((r: { visit_id: string }) => r.visit_id)
    })

    expect(remaining).toEqual(['2'])
  })

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  test('has no narrowing settings when the server sends no configuration', async () => {
    const config = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ REXConfiguration: {} })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexBrowsingPlugin
      await p.refreshConfiguration()
      return p.currentConfig()
    })

    expect(config.enabled).toBe(true)
    expect(config.internal_pages).toBe(false)
    for (const removed of ['capture_scope', 'capture_rules', 'capture_block_lists', 'capture_allow_lists',
      'schemes', 'url_detail', 'debug', 'redaction']) {
      expect(config).not.toHaveProperty(removed)
    }
  })

  test('server configuration replaces the defaults', async () => {
    const config = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        REXConfiguration: {
          browsing: {
            enabled: true,
            internal_pages: true,
            max_opener_visits: 10,
            max_hop_age_days: 3
          }
        }
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexBrowsingPlugin
      await p.refreshConfiguration()
      return p.currentConfig()
    })

    expect(config.internal_pages).toBe(true)
    expect(config.max_opener_visits).toBe(10)
    expect(config.max_hop_age_days).toBe(3)
  })

  test('triggerBrowsingDrain emits stored visits and answers with the count', async () => {
    const result = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ REXConfiguration: {} })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexBrowsingPlugin
      await p.refreshConfiguration()
      await p.visitStore.record({ url: 'https://www.example.com/a', visitId: '5', referringVisitId: '4', visitTime: Date.now(), transition: 'link', isLocal: true })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(self as any).__capturedEvents = []

      const count = await new Promise((resolve) => {
        p.handleMessage({ messageType: 'triggerBrowsingDrain' }, null, resolve)
      })

      return { count, remaining: (await p.visitStore.readAll()).length }
    })

    expect(result.count).toBe(1)
    expect(result.remaining).toBe(0)
  })

  test('an unrelated message is not claimed', async () => {
    const claimed = await serviceWorker.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexBrowsingPlugin
      return p.handleMessage({ messageType: 'getIdentifier' }, null, () => {})
    })

    expect(claimed).toBe(false)
  })

  test('disabling the module stops capture', async () => {
    const stored = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ REXConfiguration: { browsing: { enabled: false } } })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexBrowsingPlugin
      await p.refreshConfiguration()
      await p.captureVisit({ id: '1', url: 'https://www.example.com/a' })
      return await p.visitStore.readAll()
    })

    expect(stored).toHaveLength(0)
  })

  test('a disabled module emits nothing, including visits captured before config arrived', async () => {
    // The listener is registered before configuration loads, so a cold worker
    // does not miss visits. On an arm where the module is disabled that window
    // can still capture, and the host calls triggerBrowsingDrain on its own
    // cadence — so "disabled" has to mean nothing is emitted, not merely that the
    // drain alarm is never scheduled.
    const result = await serviceWorker.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexBrowsingPlugin
      await p.visitStore.record({ url: 'https://www.example.com/a', visitId: '5', referringVisitId: '4', visitTime: Date.now(), transition: 'link', isLocal: true })

      await chrome.storage.local.set({ REXConfiguration: { browsing: { enabled: false } } })
      await p.refreshConfiguration()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(self as any).__capturedEvents = []
      const viaMessage = await new Promise((resolve) => {
        p.handleMessage({ messageType: 'triggerBrowsingDrain' }, null, resolve)
      })
      const viaAlarm = await p.drain()

      return {
        viaMessage,
        viaAlarm,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        emitted: (self as any).__capturedEvents.filter((e: any) => e.name === 'rex-browsing-visit').length,
        stillStored: (await p.visitStore.readAll()).length,
      }
    })

    expect(result.emitted).toBe(0)
    expect(result.viaMessage).toBe(0)
    expect(result.viaAlarm).toBe(0)
    // Nothing captured while disabled may sit waiting for a later re-enable.
    expect(result.stillStored).toBe(0)
  })

  test('a disabled module refuses to drain a visit that arrives after it was turned off', async () => {
    // Isolates the drain guard from the purge. The purge empties the store at
    // configuration time; this covers a visit reaching the store afterwards,
    // which the guard is the only thing standing in front of.
    const result = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ REXConfiguration: { browsing: { enabled: false } } })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexBrowsingPlugin
      await p.refreshConfiguration()

      await p.visitStore.record({ url: 'https://www.example.com/a', visitId: '5', referringVisitId: '4', visitTime: Date.now(), transition: 'link', isLocal: true })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(self as any).__capturedEvents = []
      const drained = await p.drain()

      return {
        drained,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        emitted: (self as any).__capturedEvents.filter((e: any) => e.name === 'rex-browsing-visit').length,
      }
    })

    expect(result.drained).toBe(0)
    expect(result.emitted).toBe(0)
  })

  test('describes its own configuration surface', async () => {
    const details = await serviceWorker.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (self as any).rexBrowsingPlugin.configurationDetails()
    })

    // Keyed by the config section it reads, matching rex-page-manipulation.
    expect(Object.keys(details)).toEqual(['browsing'])
  })

  test('describes every setting it actually reads', async () => {
    // Compared against the live config rather than a hardcoded list, so adding a
    // setting without describing it fails here instead of silently shipping a
    // config surface only the source reveals.
    const { described, inUse } = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ REXConfiguration: {} })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexBrowsingPlugin
      await p.refreshConfiguration()
      return {
        described: Object.keys(p.configurationDetails().browsing).sort(),
        inUse: Object.keys(p.currentConfig()).sort(),
      }
    })

    expect(inUse.filter((key: string) => !described.includes(key))).toEqual([])
  })

  test('updateConfiguration applies settings without a server round trip', async () => {
    // Synchronous and directly callable, which is the point: a host or a test can
    // configure the module without a served config to fetch.
    const result = await serviceWorker.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexBrowsingPlugin
      const returned = p.updateConfiguration({ internal_pages: true })
      const wanted = p.internalPages.isWanted()
      p.updateConfiguration({})

      return {
        isPromise: returned instanceof Promise,
        wanted,
        wantedByDefault: p.internalPages.isWanted(),
      }
    })

    expect(result.isPromise).toBe(false)
    expect(result.wanted).toBe(true)
    expect(result.wantedByDefault).toBe(false)
  })

  test('the module owns no alarm; the host drives draining', async () => {
    const alarms = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ REXConfiguration: { browsing: {} } })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (self as any).rexBrowsingPlugin.refreshConfiguration()
      return (await chrome.alarms.getAll()).map((a) => a.name)
    })

    // The host extension owns what runs when; a module scheduling itself would be
    // invisible in that accounting.
    expect(alarms.filter((n: string) => n.includes('browsing'))).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Listener registration
  // -------------------------------------------------------------------------

  test('registers its history listener in setup(), not at module scope', async () => {
    // Chris's position, 2026-09-02: listeners belong in setup() and are gated on
    // whether the module is enabled, rather than listening regardless. Asserted
    // against the source because the alternative shape is invisible at runtime —
    // both register a listener; they differ in when and under what conditions.
    const fs = await import('node:fs')
    const source = fs.readFileSync(path.join(__dirname, '../../src/service-worker.mts'), 'utf8')

    const listenerAt = source.indexOf('chrome.history.onVisited.addListener')
    const classEndsAt = source.indexOf('const plugin = new BrowsingServiceWorkerModule()')

    // Inside the class, reached from setup(), rather than at module scope.
    expect(listenerAt).toBeGreaterThan(-1)
    expect(listenerAt).toBeLessThan(classEndsAt)
    // Nothing may register a listener at module scope.
    expect(source.slice(classEndsAt).includes('addListener')).toBe(false)
    // And the module schedules nothing of its own.
    expect(source.includes('chrome.alarms.create')).toBe(false)
  })

  test('setup() called twice does not stack listeners', async () => {
    const calls = await serviceWorker.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexBrowsingPlugin
      await chrome.storage.local.set({ REXConfiguration: { browsing: { enabled: true } } })
      await p.setup()
      await p.setup()

      const real = chrome.history.getVisits
      let seen = 0
      chrome.history.getVisits = async () => {
        seen += 1
        return [{ id: '1', visitId: '5', referringVisitId: '4', visitTime: Date.now(), transition: 'link', isLocal: true }] as never
      }
      try {
        await p.captureVisit({ id: '1', url: 'https://www.example.com/a' })
      } finally {
        chrome.history.getVisits = real
      }
      return seen
    })

    expect(calls).toBe(1)
  })

  test('a disabled module captures nothing even if captureVisit is called directly', async () => {
    // Chris, 2026-09-02: "if something goofs up the gate check for some reason,
    // we're gathering data when we shouldn't be." Removing the listener is the
    // outer guard; this is the inner one. Both must hold independently.
    const stored = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ REXConfiguration: { browsing: { enabled: false } } })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexBrowsingPlugin
      await p.refreshConfiguration()

      const real = chrome.history.getVisits
      chrome.history.getVisits = async () => ([
        { id: '1', visitId: '77', referringVisitId: '76', visitTime: Date.now(), transition: 'link', isLocal: true }
      ]) as never
      try {
        await p.captureVisit({ id: '1', url: 'https://example.com/anything' })
      } finally {
        chrome.history.getVisits = real
      }

      return (await p.visitStore.readAll()).length
    })

    expect(stored).toBe(0)
  })

  test('a disabled module holds no listener at all', async () => {
    const states = await serviceWorker.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexBrowsingPlugin

      await chrome.storage.local.set({ REXConfiguration: { browsing: { enabled: true } } })
      await p.refreshConfiguration()
      const whenEnabled = p.isListening()

      await chrome.storage.local.set({ REXConfiguration: { browsing: { enabled: false } } })
      await p.refreshConfiguration()
      const whenDisabled = p.isListening()

      // And it comes back, rather than being a one-way door.
      await chrome.storage.local.set({ REXConfiguration: { browsing: { enabled: true } } })
      await p.refreshConfiguration()
      const whenReEnabled = p.isListening()

      return { whenEnabled, whenDisabled, whenReEnabled }
    })

    // Chris, 2026-09-02: "we shouldn't be listening when the module is disabled".
    // Not a listener that declines to act — no listener.
    expect(states.whenEnabled).toBe(true)
    expect(states.whenDisabled).toBe(false)
    expect(states.whenReEnabled).toBe(true)
  })

  test('listens before configuration arrives, since a missed visit is unrecoverable', async () => {
    const listening = await serviceWorker.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (self as any).rexBrowsingPlugin
      await chrome.storage.local.set({ REXConfiguration: { browsing: { enabled: false } } })
      await p.refreshConfiguration()

      // setup() starts listening synchronously, before it awaits the fetch.
      const promise = p.setup()
      const duringFetch = p.isListening()
      await promise

      return { duringFetch, afterFetch: p.isListening() }
    })

    expect(listening.duringFetch).toBe(true)
    // ...and the disabled configuration then takes the listener away again.
    expect(listening.afterFetch).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Recorded visits
  //
  // Driven through real navigations rather than a synthesised HistoryItem: what
  // is under test is what Chrome reports for a visit and a redirect chain, and
  // a hand-made item would let the test pass while the real record changed.
  // -------------------------------------------------------------------------

  test.describe('recorded visits', () => {
    const PORT = 8793
    const ORIGIN = `http://dashboard.example.com:${PORT}`
    const PAGE_TITLE = 'Plain test page'
    let server: import('http').Server

    test.beforeAll(async () => {
      const http = await import('http')
      server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', ORIGIN)

        if (url.pathname === '/redirect') {
          res.writeHead(302, { location: `/plain${url.search}` })
          res.end()
          return
        }

        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<!doctype html><meta charset="utf-8"><title>${PAGE_TITLE}</title><h1>${url.pathname}</h1>`)
      })
      await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve))

      await serviceWorker.evaluate(async () => {
        await chrome.storage.local.set({
          REXConfiguration: { browsing: { enabled: true } },
          rexIdentifier: 'browsing-test-participant'
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (self as any).rexBrowsingPlugin.refreshConfiguration()
      })
    })

    test.afterAll(async () => {
      // close() alone waits on keep-alive sockets the browser is holding open,
      // which outlasts the hook timeout.
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    /** Visit a URL in a real tab and wait for Chrome to record it and its title. */
    async function visit(url: string) {
      const tab = await context.newPage()
      await tab.goto(url)
      await tab.waitForLoadState('load')
      await tab.waitForTimeout(700)
      await tab.close()
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function drainVisits(): Promise<any[]> {
      return serviceWorker.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = self as any
        g.__capturedEvents = []
        await g.rexBrowsingPlugin.drain()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return g.__capturedEvents.filter((e: any) => e.name === 'rex-browsing-visit')
      })
    }

    function marker(): string {
      return `${Date.now()}-${Math.random().toString(36).slice(2)}`
    }

    test('records an ordinary visit as rex-browsing-visit with the history-visit fields', async () => {
      const visitedUrl = `${ORIGIN}/plain?marker=${marker()}`
      await visit(visitedUrl)

      const events = await drainVisits()
      const matching = events.filter((e) => e.url === visitedUrl)
      expect(matching).toHaveLength(1)

      const recorded = matching[0]
      expect(recorded.name).toBe('rex-browsing-visit')
      expect(recorded.url).toBe(visitedUrl)
      expect(recorded.recorded_url).toBe(visitedUrl)
      expect(recorded.domain).toBe('example.com')
      expect(recorded.title).toBe(PAGE_TITLE)
      expect(typeof recorded.visit_id).toBe('string')
      expect(typeof recorded.referring_visit_id).toBe('string')
      expect(recorded.transition_type).toBeDefined()
      expect(typeof recorded.is_local).toBe('boolean')
      expect(typeof recorded.visit_time).toBe('number')
      expect(recorded.date).toBe(recorded.visit_time)
      expect(typeof recorded.history_item_id).toBe('string')
      expect(typeof recorded.last_visit_time).toBe('number')
      expect(recorded.visit_count).toBeGreaterThanOrEqual(1)
      expect(typeof recorded.typed_count).toBe('number')
      expect(recorded).not.toHaveProperty('categories')
      expect(recorded).not.toHaveProperty('capture_rule')
    })

    test('records a redirect step and its landing page as two visits', async () => {
      const id = marker()
      const stepUrl = `${ORIGIN}/redirect?marker=${id}`
      const landingUrl = `${ORIGIN}/plain?marker=${id}`
      await visit(stepUrl)

      const events = await drainVisits()
      const step = events.find((e) => e.url === stepUrl)
      const landing = events.find((e) => e.url === landingUrl)

      expect(step).toBeDefined()
      expect(landing).toBeDefined()
      expect(landing.referring_visit_id).toBe(step.visit_id)
    })

    test('records a visit no list or rule would have captured', async () => {
      const visitedUrl = `${ORIGIN}/participant/dashboard/settings?marker=${marker()}`
      await visit(visitedUrl)

      const events = await drainVisits()

      expect(events.map((e) => e.url)).toContain(visitedUrl)
    })

    test('emits a visit whose URL was deleted before drain', async () => {
      const visitedUrl = `${ORIGIN}/plain?marker=${marker()}`
      await visit(visitedUrl)

      await serviceWorker.evaluate(async (url) => {
        await chrome.history.deleteUrl({ url })
      }, visitedUrl)

      const events = await drainVisits()
      const recorded = events.find((e) => e.url === visitedUrl)

      expect(recorded).toBeDefined()
      expect(recorded.visit_id).toBeDefined()
      expect(recorded.title).toBe('')
      expect(recorded).not.toHaveProperty('visit_count')
    })
  })

  // -------------------------------------------------------------------------
  // Tab opener edges
  //
  // Chrome records no referring visit across a tab boundary, so a result opened
  // in a new tab arrives with referringVisitId "0". These drive real new tabs
  // from a real page, because what is under test is what Chrome exposes on
  // chrome.tabs when a page opens one; a synthesised event would pass while the
  // real signal changed shape. Measured 2026-09-10: openerTabId is always
  // present, pendingUrl is not, and tabs.onUpdated carries the committed URL.
  // -------------------------------------------------------------------------

  test.describe('tab opener edges', () => {
    const PORT = 8794
    const ORIGIN = `http://127.0.0.1:${PORT}`
    let server: import('http').Server

    test.beforeAll(async () => {
      const http = await import('http')
      server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', ORIGIN)

        if (url.pathname === '/start') {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end('<!doctype html><meta charset="utf-8">'
            + '<a id="same" href="/landing-same">same</a>'
            + '<a id="blank" href="/landing-blank" target="_blank">blank</a>'
            + '<a id="redirect" href="/hop" target="_blank">redirect</a>'
            + '<button id="open-empty" onclick="var w = window.open(\'\'); '
            + 'setTimeout(function () { w.location = \'/landing-open-empty\' }, 200)">open</button>'
            + '<button id="open-window" onclick="window.open(\'/landing-window\', \'_blank\', \'popup,width=600,height=400\')">window</button>')
          return
        }

        if (url.pathname === '/hop') {
          res.writeHead(302, { location: '/landing-redirect' })
          res.end()
          return
        }

        // Opens a tab, for testing the opener visit ceiling. Same host is fine
        // here: what varies is the opener's visit count, not its name.
        if (url.pathname === '/start-ceiling') {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end('<!doctype html><meta charset="utf-8">'
            + '<a id="blank" href="/landing-ceiling" target="_blank">blank</a>')
          return
        }


        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<!doctype html><meta charset="utf-8"><h1>${url.pathname}</h1>`)
      })
      await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve))
    })

    test.afterAll(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    test.beforeEach(async () => {
      await serviceWorker.evaluate(async () => {
        const keys = (await chrome.storage.local.getKeys())
          .filter((key) => key.startsWith('rexBrowsingVisit:') || key.startsWith('rexBrowsingOpener:'))
        if (keys.length > 0) await chrome.storage.local.remove(keys)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(self as any).__capturedEvents = []
      })
    })

    /** The newest visit Chrome holds for a URL, as analysis would see it. */
    async function newestVisit(url: string) {
      return serviceWorker.evaluate(async (url) => {
        const visits = await chrome.history.getVisits({ url })
        const newest = visits.reduce((best, v) => (best === null || (v.visitTime ?? 0) > (best.visitTime ?? 0) ? v : best), null as chrome.history.VisitItem | null)
        return newest === null ? null : { visitId: newest.visitId, referringVisitId: newest.referringVisitId }
      }, url)
    }

    /**
     * Load /start, open a link from it, wait for the new tab to land, then
     * report what the module stored and what Chrome recorded.
     */
    async function openFromStart(selector: string, landing: string, config: Record<string, unknown> = {}) {
      await serviceWorker.evaluate((config) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(self as any).rexBrowsingPlugin.updateConfiguration(config)
      }, config)

      const tab = await context.newPage()
      await tab.goto(`${ORIGIN}/start`)
      const startVisit = await newestVisit(`${ORIGIN}/start`)

      const opened = context.waitForEvent('page', { timeout: 5000 }).catch(() => null)
      await tab.click(selector)
      const newTab = await opened
      await (newTab ?? tab).waitForLoadState('load').catch(() => {})
      await tab.waitForTimeout(1200)

      const stored = await serviceWorker.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = (self as any).rexBrowsingPlugin
        return {
          openers: await p.openerStore.readAll(),
          visits: await p.visitStore.readAll(),
        }
      })

      await newTab?.close().catch(() => {})
      await tab.close()

      return { startVisit, landingVisit: await newestVisit(`${ORIGIN}${landing}`), ...stored }
    }

    test('a link opened in a new tab is attributed to the page that opened it', async () => {
      const result = await openFromStart('#blank', '/landing-blank')

      // Premise: Chrome itself recorded no referrer, so anything attributing the
      // landing came from this module and not from the browser.
      expect(result.landingVisit?.referringVisitId).toBe('0')

      expect(result.openers).toHaveLength(1)
      expect(result.openers[0].visit_id).toBe(result.landingVisit?.visitId)
      expect(result.openers[0].opener_visit_id).toBe(result.startVisit?.visitId)
      expect(result.openers[0].url).toBe(`${ORIGIN}/landing-blank`)
    })

    /**
     * Opens a tab from an opener visited enough times to test a ceiling against.
     *
     * Two visits and a ceiling of one, rather than a seeded 440,000-visit
     * profile: what is under test is the comparison and where it sits relative to
     * the lookup, and both are the same at either scale. The cost that motivates
     * the ceiling is measured separately, in
     * `AI-extension-testing/one-off/measure_opener_lookup_cost.mjs`.
     */
    async function openWithCeiling(maxOpenerVisits: number) {
      const opener = `http://127.0.0.1:${PORT}/start-ceiling`

      await serviceWorker.evaluate(async ({ opener, maxOpenerVisits }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = self as any
        g.rexBrowsingPlugin.updateConfiguration({ max_opener_visits: maxOpenerVisits })

        // A second visit, so the count exceeds a ceiling of one. The navigation
        // below supplies the first.
        await chrome.history.addUrl({ url: opener })
      }, { opener, maxOpenerVisits })

      const tab = await context.newPage()
      await tab.goto(opener)
      // Let the opener's own visit be recorded first: that looks it up too, and
      // only the lookup made when it opens a tab is under test here.
      await tab.waitForTimeout(500)

      await serviceWorker.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = self as any
        g.__lookedUp = []
        g.__realGetVisits = chrome.history.getVisits
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(chrome.history as any).getVisits = (details: { url: string }) => {
          g.__lookedUp.push(details.url)
          return g.__realGetVisits.call(chrome.history, details)
        }
      })

      const opened = context.waitForEvent('page', { timeout: 5000 }).catch(() => null)
      await tab.click('#blank')
      const newTab = await opened
      await (newTab ?? tab).waitForLoadState('load').catch(() => {})
      await tab.waitForTimeout(1200)

      const result = await serviceWorker.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = self as any
        ;(chrome.history as any).getVisits = g.__realGetVisits
        return {
          openers: await g.rexBrowsingPlugin.openerStore.readAll(),
          lookedUp: g.__lookedUp as string[]
        }
      })

      await newTab?.close().catch(() => {})
      await tab.close()

      return { opener, ...result }
    }

    test('an opener past the visit ceiling is not looked up, and records no edge', async () => {
      const result = await openWithCeiling(1)

      expect(result.lookedUp).not.toContain(result.opener)
      expect(result.openers).toHaveLength(0)
    })

    test('a ceiling of 0 removes the limit, so a study can turn it off', async () => {
      // Premise for the test above: the same walk with the ceiling disabled DOES
      // look the opener up and record the edge, so the absences there are the
      // ceiling acting rather than a fixture that never opened a tab.
      const result = await openWithCeiling(0)

      expect(result.lookedUp).toContain(result.opener)
      expect(result.openers).toHaveLength(1)
    })

    test('a same-tab link records no opener edge, since Chrome attributes it already', async () => {
      const result = await openFromStart('#same', '/landing-same')

      // Positive control for the test above: the same click in the same tab
      // IS attributed by Chrome, so the "0" there is the tab boundary acting.
      expect(result.landingVisit?.referringVisitId).toBe(result.startVisit?.visitId)
      expect(result.openers).toHaveLength(0)
    })

    test('a tab opened blank and then navigated is attributed to its opener', async () => {
      const result = await openFromStart('#open-empty', '/landing-open-empty')

      expect(result.landingVisit?.referringVisitId).toBe('0')
      expect(result.openers).toHaveLength(1)
      expect(result.openers[0].visit_id).toBe(result.landingVisit?.visitId)
      expect(result.openers[0].opener_visit_id).toBe(result.startVisit?.visitId)
    })

    test('a link opened in a new window is attributed to its opener, since a window is a tab boundary too', async () => {
      // The popup feature string is what makes Chrome open a separate window
      // rather than a tab; it still creates the tab with an openerTabId.
      const result = await openFromStart('#open-window', '/landing-window')

      expect(result.landingVisit?.referringVisitId).toBe('0')
      expect(result.openers).toHaveLength(1)
      expect(result.openers[0].visit_id).toBe(result.landingVisit?.visitId)
      expect(result.openers[0].opener_visit_id).toBe(result.startVisit?.visitId)
    })

    test('the drained edge attaches to the redirect hop, so landing -> hop -> opener closes', async () => {
      const result = await openFromStart('#redirect', '/landing-redirect')
      const hopVisit = await newestVisit(`${ORIGIN}/hop`)

      // Chrome's own chain: landing refers to the hop, and the hop refers to
      // nothing, because the hop was the first page in the new tab.
      expect(result.landingVisit?.referringVisitId).toBe(hopVisit?.visitId)
      expect(hopVisit?.referringVisitId).toBe('0')
      // The hop is recorded as an ordinary visit.
      expect(result.visits.map((h: { visit_id: string }) => h.visit_id)).toContain(hopVisit?.visitId)

      const events = await serviceWorker.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = (self as any).rexBrowsingPlugin
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(self as any).__capturedEvents = []
        await p.drain()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (self as any).__capturedEvents
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const openerPoints = events.filter((e: any) => e.name === 'rex-browsing-opener')
      expect(openerPoints).toHaveLength(1)
      // Attached to the root of the chain in the new tab, which is where Chrome
      // recorded "0", rather than to the landing page.
      expect(openerPoints[0].visit_id).toBe(hopVisit?.visitId)
      expect(openerPoints[0].referring_visit_id).toBe(result.startVisit?.visitId)
      expect(openerPoints[0].url).toBe(`${ORIGIN}/hop`)
      // And the hop itself still goes out as a visit.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(events.filter((e: any) => e.name === 'rex-browsing-visit').map((e: any) => e.visit_id)).toContain(hopVisit?.visitId)
    })

    test('the drained edge carries ids and the landing address', async () => {
      const result = await openFromStart('#blank', '/landing-blank')

      const events = await serviceWorker.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = (self as any).rexBrowsingPlugin
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(self as any).__capturedEvents = []
        await p.drain()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (self as any).__capturedEvents.filter((e: any) => e.name === 'rex-browsing-opener')
      })

      expect(events).toHaveLength(1)
      expect(events[0].visit_id).toBe(result.landingVisit?.visitId)
      expect(events[0].referring_visit_id).toBe(result.startVisit?.visitId)
      expect(events[0].url).toBe(`${ORIGIN}/landing-blank`)
      expect(events[0]).not.toHaveProperty('capture_rule')

      const remaining = await serviceWorker.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (await (self as any).rexBrowsingPlugin.openerStore.readAll()).length
      })
      expect(remaining).toBe(0)
    })

    test('tab_opener_edges: false records nothing and holds no tabs listener', async () => {
      const result = await openFromStart('#blank', '/landing-blank', { tab_opener_edges: false })

      expect(result.landingVisit?.referringVisitId).toBe('0')
      expect(result.openers).toHaveLength(0)

      const listening = await serviceWorker.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = (self as any).rexBrowsingPlugin
        const whenOff = p.isListeningForTabs()
        p.updateConfiguration({ tab_opener_edges: true })
        const whenOn = p.isListeningForTabs()
        p.updateConfiguration({ enabled: false })
        const whenDisabled = p.isListeningForTabs()
        p.updateConfiguration({})
        return { whenOff, whenOn, whenDisabled, byDefault: p.isListeningForTabs() }
      })

      expect(listening.whenOff).toBe(false)
      expect(listening.whenOn).toBe(true)
      expect(listening.whenDisabled).toBe(false)
      expect(listening.byDefault).toBe(true)
    })

    test('disabling the module discards stored opener edges too', async () => {
      const remaining = await serviceWorker.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = (self as any).rexBrowsingPlugin
        await p.openerStore.put({
          visit_id: '9', referring_visit_id: '0', opener_visit_id: '3', visit_time: Date.now(),
          url: 'https://www.example.com/a', transition: 'link'
        })
        await chrome.storage.local.set({ REXConfiguration: { browsing: { enabled: false } } })
        await p.refreshConfiguration()
        const afterDisable = (await p.openerStore.readAll()).length
        await chrome.storage.local.set({ REXConfiguration: {} })
        await p.refreshConfiguration()
        return afterDisable
      })

      expect(remaining).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // Internal pages
  //
  // Chrome keeps its own pages (chrome://version, AI Mode's
  // chrome://contextual-tasks) out of history, so onVisited never fires for
  // them and no visit id exists. tabs.onUpdated still carries the committed
  // URL, so these drive a real tab to a real chrome:// page rather than
  // synthesising the event. AI-Extension#132.
  // -------------------------------------------------------------------------

  test.describe('internal pages', () => {
    test.beforeEach(async () => {
      await serviceWorker.evaluate(async () => {
        const keys = (await chrome.storage.local.getKeys()).filter((key) => key.startsWith('rexBrowsingPage:'))
        if (keys.length > 0) await chrome.storage.local.remove(keys)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(self as any).__capturedEvents = []
      })
    })

    test.afterAll(async () => {
      await serviceWorker.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(self as any).rexBrowsingPlugin.updateConfiguration({})
      })
    })

    /** Configure, open a tab on the URL, and report what the module stored. */
    async function visitInternalPage(url: string, config: Record<string, unknown>) {
      await serviceWorker.evaluate((config) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(self as any).rexBrowsingPlugin.updateConfiguration(config)
      }, config)

      const tab = await context.newPage()
      await tab.goto(url).catch(() => {})
      await tab.waitForTimeout(800)
      await tab.close()

      return serviceWorker.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (self as any).rexBrowsingPlugin.pageStore.readAll()
      })
    }

    async function drainPages() {
      return serviceWorker.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = self as any
        g.__capturedEvents = []
        await g.rexBrowsingPlugin.drain()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return g.__capturedEvents.filter((e: any) => e.name === 'rex-browsing-page')
      })
    }

    test('a chrome:// page is recorded when the study turns on internal_pages', async () => {
      const stored = await visitInternalPage('chrome://version/', { internal_pages: true })

      // Premise: Chrome itself recorded nothing, so this record is the only one.
      const inHistory = await serviceWorker.evaluate(async () =>
        (await chrome.history.getVisits({ url: 'chrome://version/' })).length)
      expect(inHistory).toBe(0)

      expect(stored).toHaveLength(1)
      expect(stored[0].url).toBe('chrome://version/')

      const points = await drainPages()
      expect(points).toHaveLength(1)
      expect(points[0].url).toBe('chrome://version/')
      expect(typeof points[0].visit_time).toBe('number')
      expect(points[0].date).toBe(points[0].visit_time)
      expect(typeof points[0].tab_id).toBe('number')
      // Chrome assigns these pages no visit, so there is no id to emit.
      expect(points[0].visit_id).toBeUndefined()
      expect(points[0].referring_visit_id).toBeUndefined()

      const remaining = await serviceWorker.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (await (self as any).rexBrowsingPlugin.pageStore.readAll()).length
      })
      expect(remaining).toBe(0)
    })

    test('a chrome:// page is not recorded by default', async () => {
      const stored = await visitInternalPage('chrome://version/', {})

      expect(stored).toHaveLength(0)
    })

    test('a page Chrome does record in history is left to the history path', async () => {
      const recorded = await serviceWorker.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = (self as any).rexBrowsingPlugin
        p.updateConfiguration({ internal_pages: true })
        return {
          web: await p.captureInternalPage(1, 'https://example.com/'),
          file: await p.captureInternalPage(1, 'file:///tmp/page.html'),
          stored: (await p.pageStore.readAll()).length
        }
      })

      expect(recorded).toEqual({ web: false, file: false, stored: 0 })
    })

    test('a disabled module records nothing even if captureInternalPage is called directly', async () => {
      const recorded = await serviceWorker.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = (self as any).rexBrowsingPlugin
        p.updateConfiguration({ enabled: false, internal_pages: true })
        const whenDisabled = await p.captureInternalPage(1, 'chrome://version/')
        p.updateConfiguration({ internal_pages: true })
        const whenEnabled = await p.captureInternalPage(1, 'chrome://version/')
        return { whenDisabled, whenEnabled }
      })

      // Positive control first: the same call does record once enabled.
      expect(recorded.whenEnabled).toBe(true)
      expect(recorded.whenDisabled).toBe(false)
    })

    test('internal_pages holds a tabs listener without turning on opener edges', async () => {
      const result = await serviceWorker.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = (self as any).rexBrowsingPlugin
        p.updateConfiguration({ tab_opener_edges: false })
        const withNeither = p.isListeningForTabs()
        p.updateConfiguration({ tab_opener_edges: false, internal_pages: true })
        const withPages = p.isListeningForTabs()
        // A new tab with an opener would start an opener lookup if this
        // listener still served opener edges.
        p.tabListeners.created({ id: 424242, openerTabId: 1 })
        const reserved = p.tabOpeners.pending.has(424242)
        p.tabOpeners.forgetAll()
        p.updateConfiguration({ enabled: false, internal_pages: true })
        const whenDisabled = p.isListeningForTabs()
        return { withNeither, withPages, reserved, whenDisabled }
      })

      expect(result).toEqual({ withNeither: false, withPages: true, reserved: false, whenDisabled: false })
    })

    test('disabling the module discards stored internal pages too', async () => {
      const remaining = await serviceWorker.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = (self as any).rexBrowsingPlugin
        p.updateConfiguration({ internal_pages: true })
        await p.captureInternalPage(1, 'chrome://version/')
        const beforeDisable = (await p.pageStore.readAll()).length
        await chrome.storage.local.set({ REXConfiguration: { browsing: { enabled: false } } })
        await p.refreshConfiguration()
        const afterDisable = (await p.pageStore.readAll()).length
        await chrome.storage.local.set({ REXConfiguration: {} })
        await p.refreshConfiguration()
        return { beforeDisable, afterDisable }
      })

      expect(remaining).toEqual({ beforeDisable: 1, afterDisable: 0 })
    })
  })
})
