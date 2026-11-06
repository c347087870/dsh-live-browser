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
  const GUEST_SELECTOR =
    'webview[data-sidebar-browser-frame="webview"], iframe[data-sidebar-browser-frame="iframe"]'

  /**
   * What to tell a user whose sidebar rendered the Web build's iframe.
   *
   * An iframe is cross-origin to the DSH page, so the parent cannot read its
   * document or inject the agent script. That is a browser security boundary,
   * not a missing feature in this plugin; the only full-capability path is the
   * Desktop build, whose browser tab is an Electron <webview>.
   */
  const IFRAME_HINT =
    '当前右侧栏打开的是 Web 版 iframe 浏览器，页面与 DSH 跨域，浏览器同源策略禁止插件注入脚本，点击/输入/读取/执行脚本都无法工作。' +
    '请改用 DSH 桌面版的 webview 浏览器：1) 关闭浏览器里的 DSH 页面（地址形如 http://127.0.0.1:54249）；' +
    '2) 启动 DeepSeek Harness 桌面客户端（Windows 开始菜单里的 DeepSeek Harness，或 D:\\软件\\deepseekHARNESS\\DeepSeek Harness.exe）；' +
    '3) 在桌面客户端打开同一个会话，点右侧栏「浏览器」标签页。桌面版浏览器是 Electron <webview>，browser_* 工具即可正常操作。'

  const guestKind = (element) =>
    typeof element?.tagName === 'string' && element.tagName.toLowerCase() === 'iframe'
      ? 'iframe'
      : 'webview'

  const isIframeGuest = (element) => guestKind(element) === 'iframe'

  /** One per conversation: DSH keeps a sidebar mounted for each chat it visited. */
  const SESSION_SELECTOR = '[data-sidebar-right-session]'

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
      /** Behaviour flags the host owns; read right before an auto-open. */
      config: () => call('config', {}),
      /** Tab management is a host concern: only it can drive the sidebar. */
      tabCommand: (action, params) => call('tabCommand', { action, params }),
      /** Read a local file the agent wants to attach to a file input. */
      readUpload: (path) => call('readUpload', { path }),
    }
  }

  /**
   * Drive whichever sidebar-browser guests exist.
   *
   * @param {{ bridge: ReturnType<typeof createRuntime>, loadSource: () => Promise<string>, openPanel?: (url?: string, sessionId?: string) => Promise<object>, documentRef?: Document, currentSessionId?: () => string | undefined }} options
   */
  function createDriver({ bridge, loadSource, openPanel, documentRef, currentSessionId, listSessions }) {
    /** Stable prefix; each conversation gets its own panel id below. */
    const basePanelId = `panel-${Math.random().toString(36).slice(2, 10)}`
    /** @type {Map<Element, {ready: boolean, installed: boolean, url: string, failure?: string}>} */
    const known = new Map()
    /**
     * One long-poll per conversation.
     *
     * A single poller used to follow whatever chat was on screen, so switching
     * chats silently re-bound the only panel and commands queued for the other
     * chat were rejected. DSH keeps each chat's sidebar mounted; giving every
     * mounted sidebar its own panel keeps background conversations working.
     *
     * @type {Map<string, {panelId: string, timer: any, lastSeen: number, stopped: boolean}>}
     */
    const workers = new Map()
    let source = ''
    let stopped = false
    let discoveryTimer

    const scope = () => documentRef ?? (typeof document === 'undefined' ? undefined : document)

    /** One small, dismissible notice for the Web build's iframe browser. */
    let iframeNotice
    let iframeNoticeDismissed = false
    const hideIframeNotice = () => {
      if (iframeNotice !== undefined && iframeNotice.isConnected) iframeNotice.remove()
      iframeNotice = undefined
    }
    const dismissIframeNotice = () => {
      iframeNoticeDismissed = true
      hideIframeNotice()
    }
    const showIframeNotice = () => {
      if (iframeNoticeDismissed) return
      if (iframeNotice !== undefined && iframeNotice.isConnected) return
      const doc = scope()
      if (doc === undefined || doc.body === undefined || doc.body === null) return
      const notice = doc.createElement('div')
      notice.dataset.dshLiveBrowserIframeNotice = ''
      notice.setAttribute('role', 'status')
      notice.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:440px;' +
        'padding:12px 14px;border:1px solid #ffd591;border-radius:8px;background:#fff7e6;' +
        'color:#613400;box-shadow:0 6px 20px rgba(0,0,0,.16);font:13px/1.55 system-ui,sans-serif;'
      const text = doc.createElement('div')
      text.textContent =
        '当前右侧栏是 iframe 浏览器，插件无法执行点击/输入/读取。请改用 DSH 桌面版 webview：' +
        '关闭浏览器里的 DSH 页面 → 启动 DeepSeek Harness 桌面客户端 → 打开同一会话 → 点右侧栏「浏览器」。'
      const close = doc.createElement('button')
      close.type = 'button'
      close.textContent = '知道了'
      close.style.cssText =
        'margin-top:8px;padding:3px 10px;border:1px solid #ffd591;border-radius:5px;' +
        'background:#fff;color:#613400;font:12px system-ui,sans-serif;cursor:pointer;'
      close.addEventListener('click', dismissIframeNotice)
      notice.append(text, close)
      doc.body.appendChild(notice)
      iframeNotice = notice
    }

    /**
     * The sidebar the human is looking at.
     *
     * Re-read on every tick rather than cached: switching chats swaps which
     * session view is shown without this component remounting, and a stale
     * element would let one chat's command run against another chat's page.
     */
    const view = () => foregroundSessionView(scope())

    /**
     * The conversation this panel is showing right now.
     *
     * The id and the guests are read from that same view, so the pair can never
     * disagree: whatever gets reported belongs to the sidebar the agent will act
     * on. Without a mounted sidebar the shell's current conversation is the only
     * source left, and it is exactly where a cold start has to open the tab.
     */
    const currentSession = () => {
      // The shell's own selection is authoritative for the visible tab. It is
      // only used to decide which sidebar is on screen (and to make sure the
      // visible chat has a worker before its first browser tab exists); every
      // worker below polls for a fixed session id, so background chats keep
      // working while the user is looking elsewhere.
      const current = currentSessionId?.()
      if (current !== undefined) return current
      const shown = view()
      if (shown !== undefined) return viewSessionId(shown)
      return undefined
    }

    /**
     * The sidebar of one conversation, or the one on screen when none is named.
     *
     * A command names its conversation; the guest has to come from that same
     * chat's sidebar even when the user has switched to another one meanwhile.
     */
    const viewsFor = (target) => {
      const all = sessionViews(scope())
      if (target === undefined) {
        const shown = view()
        return shown === undefined ? [] : [shown]
      }
      return all.filter((candidate) => viewSessionId(candidate) === target)
    }

    const viewFor = (target) => {
      const candidates = viewsFor(target)
      // The same conversation can expose more than one
      // [data-sidebar-right-session] node (the session wrapper and the panel
      // itself, which may be portaled). Prefer the one that actually holds the
      // guest, otherwise a wrapper without a browser would shadow the panel.
      return (
        candidates.find((candidate) => candidate.querySelector(GUEST_SELECTOR) !== null) ??
        candidates[0]
      )
    }

    const findGuests = (target) => {
      const guests = []
      for (const candidate of viewsFor(target)) {
        guests.push(...candidate.querySelectorAll(GUEST_SELECTOR))
      }
      return [...new Set(guests)]
    }

    /**
     * Whether the settings still allow opening the sidebar browser by ourselves.
     *
     * Read per attempt rather than cached: the setting lives on the host and can
     * change without reloading the page. A failed read keeps the documented
     * default (allowed), so a transient host hiccup does not disable the feature.
     */
    const canAutoOpen = async () => {
      try {
        return (await bridge.config())?.autoOpenPanel !== false
      } catch {
        return true
      }
    }

    /**
     * The guest the agent should act on: the one holding focus, else the last
     * one that is actually laid out.
     *
     * Every visited tab keeps its body mounted (`keepMounted`), and DSH hides the
     * inactive ones with the `hidden` attribute. Document order therefore says
     * nothing about what the human sees: the last mounted guest is often a tab
     * that is not on screen.
     */
    const targetGuest = (target) => {
      const all = findGuests(target)
      if (all.length === 0) return undefined
      // A desktop build may have both kinds mounted while switching profiles.
      // Prefer a webview: it is the one this plugin can actually drive.
      const guests = all.some((element) => !isIframeGuest(element))
        ? all.filter((element) => !isIframeGuest(element))
        : all
      const doc = scope()
      const focused = guests.find((element) => element === doc?.activeElement)
      if (focused !== undefined) return focused
      const onScreen = guests.filter(isLaidOut)
      if (onScreen.length > 0) return onScreen[onScreen.length - 1]
      return guests[guests.length - 1]
    }

    /**
     * Wait for a usable guest to appear, tracking anything new on the way.
     *
     * @param {number} timeoutMs how long to wait
     * @param {string} [target] conversation whose sidebar to search
     * @returns {Promise<Element | undefined>} a ready guest, or undefined
     */
    const waitForGuest = async (timeoutMs, target) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        for (const candidate of findGuests(target)) {
          if (!known.has(candidate)) track(candidate)
        }
        const candidates = findGuests(target)
        const ready =
          candidates.find(
            (candidate) => !isIframeGuest(candidate) && known.get(candidate)?.ready === true,
          ) ?? candidates.find((candidate) => known.get(candidate)?.ready === true)
        if (ready !== undefined) return ready
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return undefined
    }

    /** Track a guest element and notice each new document it loads. */
    const track = (element) => {
      const state = { ready: false, installed: false, url: '', failure: undefined }
      known.set(element, state)
      if (isIframeGuest(element)) {
        // An iframe has none of the <webview> methods. Its href is readable from
        // the parent even when its document is not; that is enough to report
        // "this tab is an iframe" and hand the caller the Desktop hint.
        const refreshFrame = () => {
          try {
            state.url = typeof element.src === 'string' ? element.src : ''
          } catch {
            state.url = ''
          }
          state.ready = true
          state.installed = false
          state.failure = undefined
        }
        element.addEventListener('load', refreshFrame)
        refreshFrame()
        return
      }
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
      // There is no cross-origin scripting surface for an iframe. Returning
      // false lets `state`/`tabs` answer with the iframe description instead of
      // pretending the page is merely loading.
      if (isIframeGuest(element)) return false
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
      if (isIframeGuest(element)) {
        let sameOrigin = false
        try {
          sameOrigin = element.contentDocument !== null
        } catch {
          sameOrigin = false
        }
        return {
          kind: 'iframe',
          mode: 'iframe',
          actionRequired: 'switch-to-desktop-webview',
          id: typeof element.src === 'string' ? element.src : '',
          url: typeof element.src === 'string' ? element.src : '',
          title: element.getAttribute('title') ?? '',
          canGoBack: false,
          canGoForward: false,
          loading: false,
          sameOrigin,
          automation: false,
          hint: IFRAME_HINT,
        }
      }
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
      return { kind: 'webview', id: url, url, title, canGoBack, canGoForward, loading }
    }

    /** Perform one command on the chosen guest. */
    const dispatch = async (element, command, target) => {
      const method = String(command.method)

      // Tab management goes through the host: the sidebar owns the tab strip, and
      // a guest element cannot create or close its siblings.
      if (method === 'tabNew' || method === 'tabClose' || method === 'tabActivate') {
        return bridge.tabCommand(method, command.params ?? {})
      }

      // A Web-build iframe has no scriptable guest. It can still answer what it
      // is (so browser_status can explain the situation), but every command that
      // needs the page must stop with the Desktop/webview hint instead of
      // reporting a generic "still loading".
      if (isIframeGuest(element)) {
        if (method === 'state') return describeGuest(element)
        if (method === 'tabs') return { tabs: findGuests(target).map(describeGuest) }
        throw new Error(IFRAME_HINT)
      }

      // Browser-level commands drive the element, like the toolbar does.
      if (method in GUEST_METHODS) {
        element[GUEST_METHODS[method]]()
        return describeGuest(element)
      }
      if (method === 'navigate') {
        const url = normalizeAddress(command.params?.url)
        if (url === undefined) throw new Error('地址为空')
        await element.loadURL(url)
        return describeGuest(element)
      }
      if (method === 'tabs') {
        return { tabs: findGuests(target).map(describeGuest) }
      }
      if (method === 'state') {
        const guest = describeGuest(element ?? targetGuest(target))
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

    /** Refresh the iframe notice for the sidebar currently on screen. */
    const updateIframeNotice = (shownSession) => {
      const guests = shownSession === undefined ? [] : findGuests(shownSession)
      const hasWebview = guests.some((element) => !isIframeGuest(element))
      const iframe = hasWebview ? undefined : guests.find((element) => isIframeGuest(element))
      if (iframe === undefined) {
        iframeNoticeDismissed = false
        hideIframeNotice()
      } else {
        showIframeNotice()
      }
    }

    const stopWorker = (sessionId) => {
      const worker = workers.get(sessionId)
      if (worker === undefined) return
      worker.stopped = true
      if (worker.timer !== undefined) clearTimeout(worker.timer)
      workers.delete(sessionId)
    }

    /**
     * One request loop for one conversation.
     *
     * The panel is bound to `sessionId` for its whole life. It never reads the
     * chat currently on screen, so switching chats cannot steal or reject a
     * command that belongs to this conversation.
     */
    const tickFor = async (sessionId, worker) => {
      for (const element of findGuests(sessionId)) {
        if (!known.has(element)) track(element)
      }
      for (const element of [...known.keys()]) {
        if (!element.isConnected) known.delete(element)
      }

      let command
      try {
        command = await bridge.poll(worker.panelId, sessionId)
      } catch {
        // A failed long poll (host restarting, page hidden) backs off once.
        return true
      }
      if (command === null || command === undefined) return false

      if (command.sessionId !== undefined && command.sessionId !== sessionId) {
        await bridge.settle(worker.panelId, command.id, {
          ok: false,
          error: `这条命令属于对话 ${command.sessionId}，当前面板绑定的是 ${sessionId}；已拒绝，避免操作到错误页面。`,
        })
        return false
      }
      const target = sessionId

      // Explicit opener: create the browser tab in this conversation, even
      // while a different conversation is on screen.
      if (command.method === 'openPanel') {
        if (!(await canAutoOpen())) {
          await bridge.settle(worker.panelId, command.id, {
            ok: false,
            error:
              '当前对话的右侧栏还没有网页，且插件设置里关闭了「自动打开面板」；请先手动打开「浏览器」标签页后重试',
          })
          return false
        }
        if (openPanel === undefined) {
          await bridge.settle(worker.panelId, command.id, {
            ok: false,
            error: '右侧栏还没有打开任何网页，并且当前环境无法自动打开浏览器',
          })
          return false
        }
        try {
          await openPanel(command.params?.url, target)
        } catch (failure) {
          await bridge.settle(worker.panelId, command.id, {
            ok: false,
            error: `无法自动打开侧边栏浏览器：${String(failure?.message ?? failure)}`,
          })
          return false
        }
        const opened = await waitForGuest(8000, target)
        await bridge.settle(worker.panelId, command.id, {
          ok: true,
          value: { opened: true, hasPage: opened !== undefined },
        })
        return false
      }

      let element = targetGuest(target)
      if (element === undefined) {
        // `state`/`tabs` are status probes; they must not create tabs.
        if (command.method === 'state') {
          await bridge.settle(worker.panelId, command.id, { ok: true, value: null })
          return false
        }
        if (command.method === 'tabs') {
          await bridge.settle(worker.panelId, command.id, { ok: true, value: { tabs: [] } })
          return false
        }
        if (!(await canAutoOpen())) {
          await bridge.settle(worker.panelId, command.id, {
            ok: false,
            error:
              '当前对话的右侧栏还没有网页，且插件设置里关闭了「自动打开面板」；请先手动打开「浏览器」标签页后重试',
          })
          return false
        }
        if (openPanel === undefined) {
          await bridge.settle(worker.panelId, command.id, {
            ok: false,
            error: '右侧栏还没有打开任何网页，并且当前环境无法自动打开浏览器',
          })
          return false
        }
        try {
          await openPanel(command.method === 'navigate' ? command.params?.url : undefined, target)
        } catch (failure) {
          await bridge.settle(worker.panelId, command.id, {
            ok: false,
            error: `无法自动打开侧边栏浏览器：${String(failure?.message ?? failure)}`,
          })
          return false
        }
        element = await waitForGuest(8000, target)
        if (element === undefined) {
          await bridge.settle(worker.panelId, command.id, {
            ok: false,
            error: '侧边栏浏览器已打开，但页面还没准备好，请稍后重试',
          })
          return false
        }
      }

      const state = known.get(element)
      if (state !== undefined && state.failure !== undefined) {
        // Say what actually went wrong instead of "still loading".
        await bridge.settle(worker.panelId, command.id, {
          ok: false,
          error: `页面加载失败：${state.failure}`,
        })
        return false
      }
      if (state === undefined || !state.ready) {
        await bridge.settle(worker.panelId, command.id, {
          ok: false,
          error: '页面还在加载，请稍后重试',
        })
        return false
      }

      try {
        const value = await dispatch(element, command, target)
        await bridge.settle(worker.panelId, command.id, {
          ok: true,
          value: normalizeValue(value),
        })
      } catch (failure) {
        await bridge.settle(worker.panelId, command.id, {
          ok: false,
          error: String(failure?.message ?? failure),
        })
      }
      return false
    }

    const startWorker = (sessionId) => {
      const worker = {
        panelId: `${basePanelId}-${sessionId}`,
        timer: undefined,
        lastSeen: Date.now(),
        stopped: false,
      }
      const loop = async () => {
        if (stopped || worker.stopped) return
        let retry = false
        try {
          retry = await tickFor(sessionId, worker)
        } catch {
          retry = true
        }
        if (stopped || worker.stopped) return
        worker.timer = setTimeout(() => {
          void loop()
        }, retry ? POLL_RETRY_MS : 0)
      }
      void loop()
      return worker
    }

    /**
     * Keep one worker per mounted conversation.
     *
     * A conversation whose sidebar is hidden is still mounted by DSH; its
     * worker keeps polling, which is what lets a command finish there while the
     * user is reading another chat.
     */
    const syncWorkers = () => {
      if (stopped) return
      const visible = currentSession()
      const ids = new Set()
      if (visible !== undefined) ids.add(visible)
      for (const view of sessionViews(scope())) {
        const id = viewSessionId(view)
        if (id !== undefined) ids.add(id)
      }
      // A conversation with no browser tab has no sidebar to discover. Include
      // every live session so a cold-start navigate can create its tab even
      // while another conversation is on screen.
      try {
        for (const session of listSessions?.() ?? []) {
          const id = typeof session === 'string' ? session : session?.id
          if (typeof id === 'string' && id !== '') ids.add(id)
        }
      } catch {
        // Optional service; the DOM/current session still cover the common case.
      }
      for (const id of ids) {
        let worker = workers.get(id)
        if (worker === undefined) {
          worker = startWorker(id)
          workers.set(id, worker)
        }
        worker.lastSeen = Date.now()
      }
      // A closed chat leaves the DOM immediately but its worker may still hold
      // a queued command for a few seconds; keep it through that grace period.
      for (const [id, worker] of [...workers]) {
        if (!ids.has(id) && Date.now() - worker.lastSeen > 30000) stopWorker(id)
      }
      updateIframeNotice(visible)
    }

    return {
      async start() {
        // The host may be restarting while the page reloads; keep asking for the
        // injected script instead of leaving the panel dead until a manual reload.
        while (!stopped) {
          try {
            source = await loadSource()
            break
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 1000))
          }
        }
        if (stopped) return
        syncWorkers()
        discoveryTimer = setInterval(syncWorkers, 500)
      },
      stop() {
        stopped = true
        if (discoveryTimer !== undefined) clearInterval(discoveryTimer)
        for (const id of [...workers.keys()]) stopWorker(id)
        known.clear()
        iframeNoticeDismissed = false
        hideIframeNotice()
      },
    }
  }

  /**
   * Every sidebar currently in the document.
   *
   * DSH marks each conversation's sidebar wrapper with
   * `data-sidebar-right-session` — the same attribute the shipped sidebar uses to
   * validate its own elements. It keeps one sidebar per conversation: the selected
   * one plus every background chat that still holds `keepMounted` content, and
   * the browser tab is one of those. They are ordered by session id, not by what
   * is on screen.
   *
   * Never throws: this runs on every poll tick, and an unexpected DOM shape must
   * degrade to "no sidebar" rather than break the loop.
   *
   * @param {Document | undefined} documentRef
   * @returns {Element[]}
   */
  function sessionViews(documentRef) {
    if (documentRef === undefined || documentRef === null) return []
    try {
      if (typeof documentRef.querySelectorAll !== 'function') return []
      return [...documentRef.querySelectorAll(SESSION_SELECTOR)]
    } catch {
      return []
    }
  }

  /**
   * Which conversation one sidebar belongs to.
   *
   * @param {Element | undefined} view
   * @returns {string | undefined}
   */
  function viewSessionId(view) {
    const id = view?.dataset?.sidebarRightSession
    return typeof id === 'string' && id !== '' ? id : undefined
  }

  /**
   * The sidebar the human is looking at.
   *
   * DSH keeps the background conversations' sidebars mounted so their pages stay
   * alive, and marks those `hidden`. Reading the first
   * `[data-sidebar-right-session]` instead picked the alphabetically first
   * session, which is why the agent could drive a page from another chat.
   *
   * @param {Document | undefined} documentRef
   * @returns {Element | undefined}
   */
  function foregroundSessionView(documentRef) {
    const views = sessionViews(documentRef).filter((view) => {
      if (typeof view.hasAttribute === 'function' && view.hasAttribute('hidden')) return false
      if (typeof view.closest === 'function' && view.closest('[hidden]') !== null) return false
      // Background sessions may be hidden with CSS rather than the `hidden`
      // attribute, and a portaled panel can keep a non-zero box there. A view
      // that is not laid out is not the one the human is looking at.
      return isLaidOut(view)
    })
    const active = documentRef?.activeElement
    const focused =
      active === undefined || active === null
        ? undefined
        : views.find((view) => typeof view.contains === 'function' && view.contains(active))
    return focused ?? views[0]
  }

  /**
   * Whether a guest has a box on screen.
   *
   * Inactive tabs stay mounted but hidden, so their guests keep existing while the
   * human cannot see them. A laid-out box is the only reliable signal.
   *
   * @param {Element} element
   */
  function isLaidOut(element) {
    try {
      if (typeof element.closest === 'function' && element.closest('[hidden]') !== null) return false
      const rect = element.getBoundingClientRect()
      return rect.width > 1 && rect.height > 1
    } catch {
      return false
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

  /**
   * The conversation the shell is showing.
   *
   * Only needed while no sidebar is mounted: the tab a cold start opens has to
   * land in the chat on screen, and the DOM has no marker to read yet.
   *
   * @param {object} ctx cordis client context
   * @returns {string | undefined}
   */
  function currentSessionId(ctx) {
    try {
      const current = ctx.get?.('uiSession')?.adapter?.current
      const key = current?.getSnapshot?.()?.key
      return typeof key === 'string' && key !== '' ? key : undefined
    } catch {
      return undefined
    }
  }

  /** Escape a value for an attribute selector (tab ids are plain, but be safe). */
  function attributeValue(value) {
    return String(value).replace(/["\\]/g, '\\$&')
  }

  /**
   * Ids of the tabs in the strip that holds `tabId`, in the order the human sees.
   *
   * The menu is opened from a chip in the tab strip; reading that strip is the
   * only way to know what "to the right" means, because the sidebar keeps its
   * tab order internal. Returns [] when the tab is not in a strip (floating pane).
   *
   * @param {Document | undefined} documentRef
   * @param {string} tabId
   * @returns {string[]}
   */
  function tabStripIds(documentRef, tabId) {
    if (documentRef === undefined || documentRef === null || tabId === undefined) return []
    try {
      if (typeof documentRef.querySelector !== 'function') return []
      const chip = documentRef.querySelector(`[data-dockkit-tab="${attributeValue(tabId)}"]`)
      const strip = chip?.closest?.('[data-dockkit-strip-tabs]')
      if (strip === undefined || strip === null) return []
      return [...strip.querySelectorAll('[data-dockkit-tab]')]
        .map((element) => element.dataset?.dockkitTab)
        .filter((id) => typeof id === 'string' && id !== '')
    } catch {
      return []
    }
  }

  /**
   * Which tabs each menu action closes, for the tab the menu was opened on.
   *
   * "To the right" excludes the tab itself, which is the convention every editor
   * follows; "all" includes it, and the sidebar refuses to close the last guide
   * tab on its own.
   *
   * @param {string[]} ids tab ids in strip order
   * @param {string} currentId
   * @returns {{others: string[], all: string[], right: string[]}}
   */
  function closingPlan(ids, currentId) {
    const index = ids.indexOf(currentId)
    return {
      others: ids.filter((id) => id !== currentId),
      all: [...ids],
      right: index === -1 ? [] : ids.slice(index + 1),
    }
  }

  /** Close one set of tabs through the sidebar controller, then hide the menu. */
  function closeTabs(ctx, ids, dismiss) {
    const service = ctx.reflect?.get?.('sidebarRight') ?? ctx.get?.('sidebarRight')
    if (service === undefined || service === null || typeof service.close !== 'function') return
    for (const id of ids) {
      try {
        service.close(id)
      } catch {
        /* the tab may already be gone; closing the rest still makes sense */
      }
    }
    if (typeof dismiss === 'function') dismiss()
  }

  /** Styles that make our entries indistinguishable from the sidebar's own. */
  const TAB_MENU_STYLE = `
.dsh-live-browser-menu-group{display:contents}
.dsh-live-browser-menu-item{padding:4px 7px;color:var(--dsw-alias-label-primary);font-size:calc(var(--dsh-content-font-size-secondary, 13px) - 1px);text-align:left;background:transparent;border:none;border-radius:var(--dsw-radius-md);cursor:pointer}
.dsh-live-browser-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-live-browser-menu-item:disabled{opacity:.45;cursor:default}
`

  /** Marker on our group, so the two entry points never double up. */
  const TAB_MENU_MARK = 'data-dsh-live-browser-menu'

  /**
   * Add the three close actions to the tab menu that just opened.
   *
   * The shipped sidebar exposes a React slot for extra menu entries, but that
   * registration has to win a race against the sidebar declaring the slot, and
   * when it loses it silently does nothing. The menu itself is a stable portal
   * (`[data-dockkit-tab-menu]`), so extending it here works on every build while
   * still leaving DSH unpatched.
   *
   * @param {object} ctx cordis client context
   * @param {Element | undefined} menu the open tab menu
   * @param {string | undefined} tabId the tab whose menu this is
   */
  function decorateTabMenu(ctx, menu, tabId) {
    if (menu === undefined || menu === null || tabId === undefined) return
    if (typeof menu.querySelector !== 'function') return
    if (menu.querySelector(`[${TAB_MENU_MARK}]`) !== null) return

    const doc = menu.ownerDocument ?? document
    const plan = closingPlan(tabStripIds(doc, tabId), tabId)
    const group = doc.createElement('div')
    group.className = 'dsh-live-browser-menu-group'
    group.setAttribute(TAB_MENU_MARK, '')

    const entries = [
      ['关闭其他标签页', plan.others],
      ['关闭全部标签页', plan.all],
      ['关闭右侧所有标签页', plan.right],
    ]
    for (const [label, targets] of entries) {
      const button = doc.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.className = 'dsh-live-browser-menu-item'
      button.textContent = label
      button.disabled = targets.length === 0
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        if (targets.length === 0) return
        closeTabs(ctx, targets, () => dismissTabMenu(menu))
      })
      group.appendChild(button)
    }
    menu.appendChild(group)
  }

  /** Close the menu the way an outside click does; its React state follows. */
  function dismissTabMenu(menu) {
    const doc = menu.ownerDocument ?? document
    const view = doc.defaultView
    try {
      const Pointer = view?.PointerEvent ?? PointerEvent
      doc.dispatchEvent(new Pointer('pointerdown', { bubbles: true }))
    } catch {
      try {
        const Keyboard = view?.KeyboardEvent ?? KeyboardEvent
        doc.dispatchEvent(new Keyboard('keydown', { key: 'Escape', bubbles: true }))
      } catch {
        /* no DOM events: the menu will close on the next outside click */
      }
    }
  }

  /**
   * Watch for tab context menus and decorate them.
   *
   * The menu is created in the same event as the right-click, so the tab id has
   * to be captured there; a zero-delay timer is enough time for React to commit
   * the portal.
   */
  function installTabMenu(ctx) {
    if (typeof document === 'undefined' || document === null) return undefined
    // Tests and non-DOM builds hand us a document without a head; the browser
    // tools must keep working there.
    if (typeof document.addEventListener !== 'function' || document.head === undefined || document.head === null) {
      return undefined
    }

    let style
    try {
      style = document.createElement('style')
      style.dataset.plugin = 'dsh-live-browser:tab-menu'
      style.textContent = TAB_MENU_STYLE
      document.head.appendChild(style)
    } catch {
      style = undefined
    }

    let pending
    const onContextMenu = (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-dockkit-tab]') : null
      const tabId = target?.dataset?.dockkitTab
      if (tabId === undefined) return
      pending = tabId
      setTimeout(() => {
        if (pending !== tabId) return
        pending = undefined
        decorateTabMenu(ctx, document.querySelector('[data-dockkit-tab-menu]'), tabId)
      }, 0)
    }
    document.addEventListener('contextmenu', onContextMenu, true)

    return () => {
      document.removeEventListener('contextmenu', onContextMenu, true)
      style?.remove()
    }
  }

  /** Cordis plugin entry for the client half. */
  function apply(ctx) {
    const bridge = createRuntime()

    ctx.effect(() => installTabMenu(ctx), 'dsh-live-browser: tab menu')

    // The loop is page-scoped, not component-scoped: the sidebar may unmount and
    // remount tabs without the page ever reloading.
    ctx.effect(() => {
      const driver = createDriver({
        bridge,
        loadSource: () => bridge.source(),
        // Auto-open: a tool call from a cold start must bring the browser up by
        // itself, inside the requesting conversation.
        openPanel: (url, sessionId) => openSidebarBrowser(ctx, sessionId, url),
        currentSessionId: () => currentSessionId(ctx),
        listSessions: () => {
          try {
            return ctx.get?.('sessions')?.list?.() ?? []
          } catch {
            return []
          }
        },
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
    module.exports = {
      normalizeAddress,
      normalizeValue,
      GUEST_SELECTOR,
      GUEST_METHODS,
      tabStripIds,
      closingPlan,
      closeTabs,
      decorateTabMenu,
    }
  }
})()
