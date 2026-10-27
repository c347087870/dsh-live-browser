/**
 * dsh-live-browser client half.
 *
 * The right-sidebar browser you already see is DSH's own
 * `@deepseek-ai/dsh-client-ui-sidebar-browser`: it owns the tab strip, the
 * address bar, the guest <webview> and the browser session. This plugin adds the
 * one thing that package cannot do — let the agent drive the page.
 *
 * How it attaches: the official plugin tags every guest with
 * `data-sidebar-browser-frame="webview"`, so this bundle finds those elements in
 * the live DOM, injects a command surface into each document, and polls the host
 * for work. No DSH file is modified, so app upgrades cannot break it.
 *
 * Two command families, handled differently:
 *
 *  - Page commands (click/type/snapshot/...) run *inside* the guest through the
 *    injected script.
 *  - Browser commands (navigate/back/forward/reload) drive the guest element
 *    itself, exactly the way the official plugin's toolbar does.
 *
 * Wrapped in an IIFE: DSH batches several plugin bundles into one combo
 * <script>, so a top-level `const` here would collide with a sibling bundle.
 */

;(function () {
  'use strict'

  /** Live guests are found by this attribute, owned by the official plugin. */
  const GUEST_SELECTOR = 'webview[data-sidebar-browser-frame="webview"]'

  /**
   * How long one poll request may be held open by the host.
   *
   * The old design woke the panel every 50 ms: every command paid an average
   * 25 ms of pure hand-off latency and an idle panel generated 20 HTTP requests
   * per second. A long poll removes both — the host answers the moment a
   * command is queued. The value stays below the browser's request patience.
   */
  const POLL_WAIT_MS = 25000

  /** Only used to retry after a failed poll, never on the happy path. */
  const POLL_RETRY_MS = 250

  /** Browser-level commands and the guest method that performs each. */
  const GUEST_METHODS = { back: 'goBack', forward: 'goForward', reload: 'reload' }

  /** Normalize a typed or model-supplied address. */
  function normalizeAddress(raw) {
    const text = String(raw ?? '').trim()
    if (text === '') return undefined
    // localhost / bare IP first: "localhost:5173" otherwise matches the scheme
    // pattern and turns into a nonsense URL.
    if (/^localhost(:\d+)?(\/|$)/i.test(text)) return `http://${text}`
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(text)) return `http://${text}`
    if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text
    return `https://${text}`
  }

  /** Make a page-produced value safe to send back as JSON. */
  function normalizeValue(value) {
    if (value === undefined) return null
    if (value === null || typeof value !== 'object') return value
    try {
      return JSON.parse(JSON.stringify(value))
    } catch {
      return String(value)
    }
  }

  /** The bridge to the host half: ask for work, post results. */
  function createRuntime() {
    const channel = '/dsh-live-browser'
    const call = async (endpoint, payload = {}) => {
      const rpcId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      const response = await fetch(`${channel}/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
      })
      if (!response.ok) throw new Error(`浏览器桥接不可用：HTTP ${response.status}`)
      const body = await response.json()
      const result = body?.result
      if (result?.ok === false) throw new Error(String(result?.error?.message ?? '浏览器操作失败'))
      return result?.value
    }
    return {
      // The panel announces which conversation it is rendering so the host can
      // hand it only that conversation's commands.
      poll: (panelId, sessionId) => call('poll', { panelId, sessionId, waitMs: POLL_WAIT_MS }),
      settle: (panelId, id, outcome) => call('settle', { panelId, id, outcome }),
      /** The injected script is served by the host half, so it always matches. */
      source: () => call('source', {}).then((value) => String(value?.source ?? '')),
      /** Tab management is a host concern: only it can drive the sidebar. */
      tabCommand: (action, params) => call('tabCommand', { action, params }),
      /** Read a local file the agent wants to attach to a file input. */
      readUpload: (path) => call('readUpload', { path }),
    }
  }

  /**
   * Drive whichever sidebar-browser guests exist.
   *
   * @param {{ bridge: ReturnType<typeof createRuntime>, loadSource: () => Promise<string>, openPanel?: (url?: string) => Promise<object>, documentRef?: Document }} options
   */
  function createDriver({ bridge, loadSource, openPanel, documentRef }) {
    const panelId = `panel-${Math.random().toString(36).slice(2, 10)}`
    /** @type {Map<Element, {ready: boolean, installed: boolean, url: string, failure?: string}>} */
    const known = new Map()
    let source = ''
    let stopped = false
    let busy = false
    let timer
    /** Set when the last poll round threw, so the loop backs off once. */
    let tickFailed = false

    const scope = () => documentRef ?? (typeof document === 'undefined' ? undefined : document)

    /**
     * The conversation this panel is showing right now.
     *
     * Re-read on every tick rather than cached: the user can switch chats without
     * this component remounting, and a stale id would let one chat's command run
     * against another chat's page.
     */
    const sessionId = () => readSessionId(scope())

    const findGuests = () => {
      const doc = scope()
      return doc === undefined ? [] : [...doc.querySelectorAll(GUEST_SELECTOR)]
    }

    /**
     * The guest the agent should act on: the one holding focus, else the last
     * mounted one (the sidebar mounts guests in tab order, and a newly opened
     * tab is appended last).
     */
    const targetGuest = () => {
      const guests = findGuests()
      if (guests.length === 0) return undefined
      const doc = scope()
      const focused = guests.find((element) => element === doc?.activeElement)
      return focused ?? guests[guests.length - 1]
    }

    /**
     * Wait for a usable guest to appear, tracking anything new on the way.
     *
     * @param {number} timeoutMs how long to wait
     * @returns {Promise<Element | undefined>} a ready guest, or undefined
     */
    const waitForGuest = async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        for (const candidate of findGuests()) {
          if (!known.has(candidate)) track(candidate)
        }
        const ready = findGuests().find((candidate) => known.get(candidate)?.ready === true)
        if (ready !== undefined) return ready
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return undefined
    }

    /** Track a guest element and notice each new document it loads. */
    const track = (element) => {
      const state = { ready: false, installed: false, url: '', failure: undefined }
      known.set(element, state)
      const refresh = () => {
        try {
          state.url = element.getURL()
          state.ready = state.url !== ''
        } catch {
          /* the element is between documents */
        }
        // A new document means the injected surface is gone.
        state.installed = false
        state.failure = undefined
      }
      element.addEventListener('dom-ready', refresh)
      element.addEventListener('did-navigate', refresh)
      element.addEventListener('did-navigate-in-page', refresh)
      element.addEventListener('did-start-navigation', () => { state.installed = false })
      // A page that never loads otherwise reports "still loading, retry later"
      // forever: the guest emits this instead of ever becoming ready.
      element.addEventListener('did-fail-load', (event) => {
        // ERR_ABORTED (-3) is what every ordinary redirect produces, so it is not
        // a failure worth reporting.
        if (event?.errorCode === -3) return
        state.failure = String(event?.errorDescription ?? `加载失败（${event?.errorCode ?? '?'}）`)
        state.ready = false
        state.installed = false
      })
      try {
        if (typeof element.getURL === 'function') refresh()
      } catch {
        /* not attached yet */
      }
    }

    /**
     * Inject the command surface, skipping the work when it is already there.
     *
     * The bundle is ~29 KB of source. After a same-document navigation the
     * global survives, so running a one-line probe first avoids re-sending and
     * re-evaluating the whole script on every SPA route change.
     */
    const ensureInstalled = async (element) => {
      const state = known.get(element)
      if (state === undefined) return false
      if (state.installed) return true
      if (source === '') return false
      let present = false
      try {
        present = await element.executeJavaScript(
          "typeof window.__dshBrowserAgent === 'object' && typeof window.__dshBrowserAgent.state === 'function'",
          false,
        )
      } catch {
        present = false
      }
      if (present !== true) await element.executeJavaScript(source, false)
      state.installed = true
      return true
    }

    const describeGuest = (element) => {
      const state = known.get(element)
      let url = state?.url ?? ''
      let title = ''
      let canGoBack = false
      let canGoForward = false
      let loading = false
      try {
        url = element.getURL() || url
        title = element.getTitle()
        canGoBack = element.canGoBack()
        canGoForward = element.canGoForward()
        loading = element.isLoading()
      } catch {
        /* the element is between documents */
      }
      return { id: url, url, title, canGoBack, canGoForward, loading }
    }

    /** Perform one command on the chosen guest. */
    const dispatch = async (element, command) => {
      const method = String(command.method)

      // Tab management goes through the host: the sidebar owns the tab strip, and
      // a guest element cannot create or close its siblings.
      if (method === 'tabNew' || method === 'tabClose' || method === 'tabActivate') {
        return bridge.tabCommand(method, command.params ?? {})
      }

      // Browser-level commands drive the element, like the toolbar does.
      if (method in GUEST_METHODS) {
        element[GUEST_METHODS[method]]()
        return describeGuest(element)
      }
      if (method === 'navigate') {
        const target = normalizeAddress(command.params?.url)
        if (target === undefined) throw new Error('地址为空')
        await element.loadURL(target)
        return describeGuest(element)
      }
      if (method === 'tabs') {
        return { tabs: findGuests().map(describeGuest) }
      }
      if (method === 'state') {
        const guest = describeGuest(element ?? targetGuest())
        // Page state adds the viewport and scroll offset.
        if (await ensureInstalled(element)) {
          const page = await element.executeJavaScript(
            `window.__dshBrowserAgent.state()`,
            true,
          )
          return { ...guest, ...normalizeValue(page) }
        }
        return guest
      }

      // Everything else runs inside the page.
      if (!(await ensureInstalled(element))) {
        throw new Error('无法在页面里注入操作脚本（页面可能禁止脚本执行）')
      }
      const params = { ...(command.params ?? {}) }
      const expression = `(async () => { ${source}; return await window.__dshBrowserAgent[${JSON.stringify(method)}](${JSON.stringify(params)}); })()`
      return element.executeJavaScript(expression, true)
    }

    const tick = async () => {
      if (stopped || busy) return
      busy = true
      try {
        // Keep the guest map in step with the DOM.
        for (const element of findGuests()) {
          if (!known.has(element)) track(element)
        }
        for (const element of [...known.keys()]) {
          if (!element.isConnected) known.delete(element)
        }

        const command = await bridge.poll(panelId, sessionId())
        if (command === null || command === undefined) return

        // No page on screen: this is the cold-start case. Open the sidebar
        // browser ourselves (it is the only place the page can render), give the
        // guest a moment to mount, then run the command against it. The user
        // never has to open a browser by hand, and nothing leaves DSH.
        let element = targetGuest()
        if (element === undefined) {
          if (openPanel === undefined) {
            await bridge.settle(panelId, command.id, {
              ok: false,
              error: '右侧栏还没有打开任何网页，并且当前环境无法自动打开浏览器',
            })
            return
          }
          try {
            await openPanel(
              command.method === 'navigate' ? command.params?.url : undefined,
              // Open in the chat that asked, not the chat now on screen.
              command.sessionId ?? sessionId(),
            )
          } catch (failure) {
            await bridge.settle(panelId, command.id, {
              ok: false,
              error: `无法自动打开侧边栏浏览器：${String(failure?.message ?? failure)}`,
            })
            return
          }
          element = await waitForGuest(8000)
          if (element === undefined) {
            await bridge.settle(panelId, command.id, {
              ok: false,
              error: '侧边栏浏览器已打开，但页面还没准备好，请稍后重试',
            })
            return
          }
        }

        const state = known.get(element)
        if (state !== undefined && state.failure !== undefined) {
          // Say what actually went wrong instead of "still loading".
          await bridge.settle(panelId, command.id, {
            ok: false,
            error: `页面加载失败：${state.failure}`,
          })
          return
        }
        if (state === undefined || !state.ready) {
          await bridge.settle(panelId, command.id, { ok: false, error: '页面还在加载，请稍后重试' })
          return
        }

        try {
          const value = await dispatch(element, command)
          await bridge.settle(panelId, command.id, { ok: true, value: normalizeValue(value) })
        } catch (failure) {
          await bridge.settle(panelId, command.id, {
            ok: false,
            error: String(failure?.message ?? failure),
          })
        }
      } catch {
        // Back off once so a persistently broken endpoint cannot spin.
        tickFailed = true
      } finally {
        busy = false
      }
    }

    return {
      async start() {
        source = await loadSource()
        // Long poll: one request stays open until there is work. The loop only
        // sleeps after a failure, so a healthy idle panel makes no requests.
        const loop = async () => {
          if (stopped) return
          try {
            await tick()
          } finally {
            if (stopped) return
            const wait = tickFailed === true ? POLL_RETRY_MS : 0
            tickFailed = false
            timer = setTimeout(() => { void loop() }, wait)
          }
        }
        void loop()
      },
      stop() {
        stopped = true
        clearTimeout(timer)
        known.clear()
      },
    }
  }

  /**
   * Which conversation this panel belongs to.
   *
   * The sidebar renders one Session at a time and marks its wrapper with
   * `data-sidebar-right-session`, the same attribute the shipped sidebar uses to
   * validate its own elements. Reading it from the DOM avoids depending on
   * Sidebar internals.
   *
   * Never throws: this runs on every poll tick, and an unexpected DOM shape must
   * degrade to "session unknown" (which the host treats as unbound) rather than
   * break the loop and leave the browser unresponsive.
   *
   * @param {Document | undefined} documentRef
   * @returns {string | undefined}
   */
  function readSessionId(documentRef) {
    if (documentRef === undefined || documentRef === null) return undefined
    try {
      if (typeof documentRef.querySelector !== 'function') return undefined
      const host = documentRef.querySelector('[data-sidebar-right-session]')
      const id = host?.dataset?.sidebarRightSession
      return typeof id === 'string' && id !== '' ? id : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Ask the sidebar to show the browser tab in one specific conversation.
   *
   * `openTab` targets whichever Session is on screen; `openTabIn` targets the
   * Session that asked. Using the latter is what keeps a browser in the chat
   * that requested it when the user switches chats mid-request.
   *
   * @param {object} ctx cordis client context
   * @param {string | undefined} sessionId conversation that asked
   * @param {string} [url] address to open in the new tab
   */
  async function openSidebarBrowser(ctx, sessionId, url) {
    const service = ctx.reflect?.get?.('sidebarRight') ?? ctx.get?.('sidebarRight')
    if (service === undefined || service === null) {
      throw new Error('拿不到侧边栏服务：这个 DSH 版本可能没有内置浏览器')
    }
    const options = url === undefined ? {} : { params: { url } }
    const canTarget = typeof service.openTabIn === 'function'
    if (canTarget && sessionId !== undefined) {
      service.openTabIn(sessionId, 'browser', options)
      return { opened: true, sessionId }
    }
    if (typeof service.openTab === 'function') {
      service.openTab('browser', options)
      return { opened: true, sessionId: undefined }
    }
    throw new Error('侧边栏服务没有 openTab，无法自动打开浏览器')
  }

  /** Cordis plugin entry for the client half. */
  function apply(ctx) {
    const bridge = createRuntime()

    // The loop is page-scoped, not component-scoped: the sidebar may unmount and
    // remount tabs without the page ever reloading.
    ctx.effect(() => {
      const driver = createDriver({
        bridge,
        loadSource: () => bridge.source(),
        // Auto-open: a tool call from a cold start must bring the browser up by
        // itself, inside the requesting conversation.
        openPanel: (url, sessionId) => openSidebarBrowser(ctx, sessionId, url),
      })
      void driver.start()
      return () => driver.stop()
    }, 'dsh-live-browser: agent loop')
  }

  if (typeof window !== 'undefined' && typeof window.__ModuleLoader__ === 'object') {
    window.__ModuleLoader__.load({
      id: 'dsh-live-browser',
      factory: () => ({ apply }),
    })
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = { normalizeAddress, normalizeValue, GUEST_SELECTOR, GUEST_METHODS }
  }
})()
