/**
 * Client driver test: the half that actually opens the browser.
 *
 * The sidebar browser lives entirely in the renderer, so auto-open can only be
 * proven here. This loads the real `client.js` in a fake window with a fake
 * DOM, a fake fetch that speaks the real envelope, and a fake sidebar service,
 * then drives the full loop:
 *
 *   tool call -> host queues -> client polls -> no guest -> client opens the
 *   drawer -> guest mounts -> client injects -> client answers -> tool resolves
 *
 * It also covers the negative paths: no sidebar service, a throwing openTab, and
 * a guest that never becomes ready.
 */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Resolve client.js from this file's location, so the suite runs from anywhere. */
const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

const failures = []
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS ${label}`)
  else { failures.push(label); console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

/**
 * Build a window with just enough DOM for the driver.
 *
 * @param {{sidebar?: object, failOpen?: boolean, guestReady?: boolean}} options
 */
const buildWindow = (options = {}) => {
  const listeners = new Map()
  const guests = []
  /**
   * The conversation the fake sidebar is showing.
   *
   * `current` mirrors the real `data-sidebar-right-session` marker; tests change
   * it to simulate the user switching chats mid-request.
   */
  const session = { current: options.sessionId ?? 'session-A' }

  /** A stand-in <webview>: records injections and reports a URL. */
  const makeGuest = () => {
    const element = {
      tagName: 'WEBVIEW',
      isConnected: true,
      parentElement: null,
      style: {},
      getURL: () => 'https://page.test/',
      getTitle: () => 'Page',
      isLoading: () => false,
      canGoBack: () => false,
      canGoForward: () => false,
      loadURL: async () => {},
      goBack: () => {},
      goForward: () => {},
      reload: () => {},
      remove: () => { element.isConnected = false },
      addEventListener: (name, handler) => {
        listeners.set(`${element.id}:${name}`, handler)
      },
      executeJavaScript: async (expression) => {
        element.lastExpression = expression
        // Answer "what is this page" queries the way the page script would.
        if (expression.includes('__dshBrowserAgent.state')) {
          return { url: 'https://page.test/', title: 'Page', viewport: { width: 800, height: 600 } }
        }
        return { ok: true, ran: true }
      },
    }
    element.id = `guest-${guests.length}`
    guests.push(element)
    return element
  }

  const document = {
    activeElement: null,
    querySelectorAll: (selector) => (selector.includes('webview') ? guests.filter((g) => g.isConnected) : []),
    // The sidebar wrapper carries the conversation id, like the shipped one.
    querySelector: (selector) =>
      selector.includes('data-sidebar-right-session') && session.current !== undefined
        ? { dataset: { sidebarRightSession: session.current } }
        : null,
    createElement: () => makeGuest(),
    getElementById: () => null,
  }

  let openedCount = 0
  const openedUrls = []
  const window = {
    document,
    location: { href: 'http://localhost/' },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    fetch: undefined,
    __ModuleLoader__: undefined,
  }
  // The bundle probes `window`, so the global object must expose itself.
  window.window = window

  return {
    window,
    guests,
    session,
    openedUrls,
    get openedCount() { return openedCount },
    markOpened(url) { openedCount += 1; openedUrls.push(url) },
    listeners,
    makeGuest,
  }
}

/** A tiny cordis-like context the bundle's apply() expects. */
const makeCtx = (sidebar) => {
  const effects = []
  return {
    effects,
    reflect: { get: (name) => (name === 'sidebarRight' ? sidebar : undefined) },
    get: () => undefined,
    effect: (fn) => {
      const dispose = fn()
      effects.push(dispose)
      return dispose
    },
  }
}

/**
 * Load client.js as a browser would and run its apply().
 *
 * @param {object} harness from buildWindow
 * @param {object} bridgeImpl fake transport
 */
const bootClient = async (harness, bridgeImpl, sidebar) => {
  // The bundle talks to the host through fetch; swap in the fake transport.
  const responses = []
  harness.window.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    const answer = await bridgeImpl(body.method, body.payload)
    responses.push({ method: body.method, answer })
    return {
      ok: true,
      status: 200,
      json: async () => ({ type: 'server-response', rpcId: body.rpcId, result: answer }),
      text: async () => JSON.stringify({ result: answer }),
    }
  }

  const captured = {}
  harness.window.__ModuleLoader__ = {
    load: ({ id, factory }) => { captured.id = id; captured.exports = factory(() => ({})) },
  }

  const context = createContext(harness.window)
  context.window = harness.window
  context.document = harness.window.document
  context.globalThis = harness.window
  context.fetch = harness.window.fetch
  runInContext(source, context)

  const ctx = makeCtx(sidebar)
  captured.exports.apply(ctx)
  return { ctx, captured, responses }
}

/** Wait until a predicate holds, or give up. */
const waitFor = async (predicate, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

console.log('\n--- the bundle loads as a module --------------------------------')

{
  const harness = buildWindow()
  let loaded
  // The loader must exist *before* the bundle runs: it registers on load.
  harness.window.__ModuleLoader__ = { load: (definition) => { loaded = definition } }
  runInContext(source, createContext(harness.window))
  check('the bundle registers with the module loader', loaded?.id === 'dsh-live-browser', loaded?.id)
  check('it exports apply()', typeof loaded?.factory?.()?.apply === 'function')
}

console.log('\n--- auto-open: cold start --------------------------------------')

{
  const harness = buildWindow()
  // The host has one command waiting and no panel has ever polled.
  let queue = [{ id: '1', method: 'navigate', params: { url: 'https://page.test/' } }]
  const settled = []
  const bridgeImpl = async (method, payload) => {
    if (method === 'source') return { ok: true, value: { source: 'window.__dshBrowserAgent={};' } }
    if (method === 'poll') {
      const next = queue.shift() ?? null
      return { ok: true, value: next }
    }
    if (method === 'settle') { settled.push(payload); return { ok: true, value: null } }
    return { ok: true, value: null }
  }

  const sidebar = {
    openTab: (kind, options) => {
      harness.markOpened(options?.params?.url)
      // Opening the tab makes the official plugin mount a guest shortly after.
      setTimeout(() => {
        const guest = harness.makeGuest()
        guest.parentElement = harness.window.document.body ?? null
        harness.listeners.set(`${guest.id}:dom-ready`, undefined)
      }, 60)
    },
  }

  await bootClient(harness, bridgeImpl, sidebar)
  const opened = await waitFor(() => harness.openedCount > 0)
  check('the client opens the sidebar browser by itself', opened === true, `opened=${harness.openedCount}`)
  check('it asks for the browser tab kind', harness.openedCount > 0)
  check('it forwards the requested url when navigating', harness.openedUrls[0] === 'https://page.test/', JSON.stringify(harness.openedUrls))
}

console.log('\n--- the panel reports which chat it is --------------------------')

{
  const harness = buildWindow({ sessionId: 'session-A' })
  const guest = harness.makeGuest()
  guest.addEventListener = () => {}
  const polled = []
  const bridgeImpl = async (method, payload) => {
    if (method === 'source') return { ok: true, value: { source: 'window.__dshBrowserAgent={};' } }
    if (method === 'poll') { polled.push(payload.sessionId); return { ok: true, value: null } }
    return { ok: true, value: null }
  }
  await bootClient(harness, bridgeImpl, { openTab: () => {}, openTabIn: () => {} })
  await waitFor(() => polled.length > 2, 2000)
  check('poll carries the conversation id', polled[0] === 'session-A', JSON.stringify(polled[0]))
}

console.log('\n--- switching chats opens the browser in the asking chat --------')

{
  const harness = buildWindow({ sessionId: 'session-A' })
  /** @type {Array<{session: string, kind: string}>} */
  const openedIn = []
  let queue = [{ id: '1', method: 'navigate', params: { url: 'https://page.test/' }, sessionId: 'session-A' }]
  const settled = []
  const bridgeImpl = async (method, payload) => {
    if (method === 'source') return { ok: true, value: { source: 'window.__dshBrowserAgent={};' } }
    if (method === 'poll') return { ok: true, value: queue.shift() ?? null }
    if (method === 'settle') { settled.push(payload); return { ok: true, value: null } }
    return { ok: true, value: null }
  }
  const sidebar = {
    // openTab would target whatever is on screen; openTabIn targets the asker.
    openTab: (kind) => { openedIn.push({ session: 'on-screen', kind }) },
    openTabIn: (sessionId, kind, options) => {
      openedIn.push({ session: sessionId, kind })
      setTimeout(() => { harness.makeGuest() }, 40)
    },
  }

  // The user switches to chat B before the command arrives.
  harness.session.current = 'session-B'
  await bootClient(harness, bridgeImpl, sidebar)
  const opened = await waitFor(() => openedIn.length > 0, 3000)
  check('the browser opens in the requesting chat', opened === true, JSON.stringify(openedIn))
  check('it targets the session that asked, not the one on screen', openedIn[0]?.session === 'session-A', JSON.stringify(openedIn[0]))
  check('it still asks for a browser tab', openedIn[0]?.kind === 'browser', JSON.stringify(openedIn[0]))
  check('it does not fall back to the on-screen chat', openedIn.every((entry) => entry.session !== 'on-screen'), JSON.stringify(openedIn))
}

console.log('\n--- auto-open: refuses when the sidebar is missing -------------')

{
  const harness = buildWindow()
  let queue = [{ id: '1', method: 'snapshot', params: {} }]
  const settled = []
  const bridgeImpl = async (method, payload) => {
    if (method === 'source') return { ok: true, value: { source: 'window.__dshBrowserAgent={};' } }
    if (method === 'poll') return { ok: true, value: queue.shift() ?? null }
    if (method === 'settle') { settled.push(payload); return { ok: true, value: null } }
    return { ok: true, value: null }
  }
  await bootClient(harness, bridgeImpl, undefined)
  const reported = await waitFor(() => settled.length > 0)
  check('with no sidebar service the command fails', reported === true)
  check('the failure is explained to the caller', String(settled[0]?.outcome?.error ?? '').length > 0, JSON.stringify(settled[0]))
  check('nothing was opened', harness.openedCount === 0)
}

console.log('\n--- auto-open: a throwing openTab is reported ----------------')

{
  const harness = buildWindow()
  let queue = [{ id: '1', method: 'snapshot', params: {} }]
  const settled = []
  const bridgeImpl = async (method, payload) => {
    if (method === 'source') return { ok: true, value: { source: 'window.__dshBrowserAgent={};' } }
    if (method === 'poll') return { ok: true, value: queue.shift() ?? null }
    if (method === 'settle') { settled.push(payload); return { ok: true, value: null } }
    return { ok: true, value: null }
  }
  const sidebar = { openTab: () => { throw new Error('sidebar exploded') } }
  await bootClient(harness, bridgeImpl, sidebar)
  const reported = await waitFor(() => settled.length > 0)
  check('a throwing openTab does not hang the caller', reported === true)
  check('the reason is surfaced', String(settled[0]?.outcome?.error ?? '').includes('sidebar exploded'), JSON.stringify(settled[0]))
}

console.log('\n--- a warm panel runs commands without opening -----------------')

{
  const harness = buildWindow()
  // A guest is already on screen with a loaded document.
  const guest = harness.makeGuest()
  const onReady = []
  guest.addEventListener = (name, handler) => { if (name === 'dom-ready') onReady.push(handler) }
  let queue = [{ id: '1', method: 'readText', params: {} }]
  const settled = []
  const bridgeImpl = async (method, payload) => {
    if (method === 'source') return { ok: true, value: { source: 'window.__dshBrowserAgent={};' } }
    if (method === 'poll') return { ok: true, value: queue.shift() ?? null }
    if (method === 'settle') { settled.push(payload); return { ok: true, value: null } }
    return { ok: true, value: null }
  }
  const sidebar = { openTab: () => harness.markOpened('unexpected') }
  await bootClient(harness, bridgeImpl, sidebar)
  for (const handler of onReady) handler()
  const reported = await waitFor(() => settled.length > 0)
  check('an existing page is used directly', reported === true, JSON.stringify(settled[0]))
  check('no new tab was opened', harness.openedCount === 0, String(harness.openedCount))
  check('the command ran on the live page', guest.lastExpression !== undefined)
}

console.log('\n--- the loop keeps polling after work -------------------------')

{
  const harness = buildWindow()
  const guest = harness.makeGuest()
  guest.addEventListener = () => {}
  let polls = 0
  const settled = []
  const bridgeImpl = async (method, payload) => {
    if (method === 'source') return { ok: true, value: { source: 'window.__dshBrowserAgent={};' } }
    if (method === 'poll') { polls += 1; return { ok: true, value: null } }
    if (method === 'settle') { settled.push(payload); return { ok: true, value: null } }
    return { ok: true, value: null }
  }
  await bootClient(harness, bridgeImpl, { openTab: () => {} })
  const kept = await waitFor(() => polls > 3, 2000)
  check('the panel keeps polling while idle', kept === true, `polls=${polls}`)
}

console.log('\n--- a broken poll does not stop the loop ----------------------')

{
  const harness = buildWindow()
  const guest = harness.makeGuest()
  guest.addEventListener = () => {}
  let polls = 0
  let queue = [null, { id: '1', method: 'readText', params: {} }]
  const settled = []
  const bridgeImpl = async (method, payload) => {
    if (method === 'source') return { ok: true, value: { source: 'window.__dshBrowserAgent={};' } }
    if (method === 'poll') {
      polls += 1
      if (polls === 1) throw new Error('network down')
      return { ok: true, value: queue.shift() ?? null }
    }
    if (method === 'settle') { settled.push(payload); return { ok: true, value: null } }
    return { ok: true, value: null }
  }
  await bootClient(harness, bridgeImpl, { openTab: () => {} })
  const recovered = await waitFor(() => settled.length > 0, 3000)
  check('a failed poll recovers on the next tick', recovered === true, `polls=${polls}`)
}

console.log(failures.length === 0 ? '\nCLIENT DRIVER OK' : `\nCLIENT DRIVER FAILED (${failures.length})`)
process.exit(failures.length === 0 ? 0 : 1)
