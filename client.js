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
  function createDriver({ bridge, loadSource, openPanel, documentRef, currentSessionId }) {
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
    const sessionId = () => {
      const shown = view()
      if (shown !== undefined) return viewSessionId(shown)
      return currentSessionId?.()
    }

    /**
     * The sidebar of one conversation, or the one on screen when none is named.
     *
     * A command names its conversation; the guest has to come from that same
     * chat's sidebar even when the user has switched to another one meanwhile.
     */
    const viewFor = (target) => {
      if (target === undefined) return view()
      return sessionViews(scope()).find((candidate) => viewSessionId(candidate) === target)
    }

    const findGuests = (target) => {
      const shown = viewFor(target)
      return shown === undefined ? [] : [...shown.querySelectorAll(GUEST_SELECTOR)]
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
      const guests = findGuests(target)
      if (guests.length === 0) return undefined
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
        const ready = findGuests(target).find((candidate) => known.get(candidate)?.ready === true)
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
    const dispatch = async (element, command, target) => {
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

    const tick = async () => {
      if (stopped || busy) return
      busy = true
      try {
        // Keep the guest map in step with the DOM. Every mounted conversation's
        // sidebar counts, not just the visible one: a command can name a chat the
        // user has just switched away from, and its guest still has to be tracked.
        for (const shown of sessionViews(scope())) {
          for (const element of shown.querySelectorAll(GUEST_SELECTOR)) {
            if (!known.has(element)) track(element)
          }
        }
        for (const element of [...known.keys()]) {
          if (!element.isConnected) known.delete(element)
        }

        const command = await bridge.poll(panelId, sessionId())
        if (command === null || command === undefined) return

        // The conversation on screen *now*. The poll above may have been parked
        // for up to 25 s, so the panel can still be registered against the chat
        // the user was in when it started; a command handed over in that window
        // would otherwise run against a page that is no longer visible.
        const shown = sessionId()
        if (command.sessionId !== undefined && shown !== undefined && command.sessionId !== shown) {
          await bridge.settle(panelId, command.id, {
            ok: false,
            error: `这条命令属于另一个对话（${command.sessionId}），当前显示的是 ${shown}；为避免操作到看不见的页面，已拒绝。请切回发起命令的对话后重试。`,
          })
          return
        }

        // The sidebar that belongs to the command's own conversation. A command
        // without one comes from an older caller and belongs to whatever is shown.
        const target = command.sessionId ?? shown

        // No page on screen: this is the cold-start case. Open the sidebar
        // browser ourselves (it is the only place the page can render), give the
        // guest a moment to mount, then run the command against it. The user
        // never has to open a browser by hand, and nothing leaves DSH.
        let element = targetGuest(target)
        if (element === undefined) {
          if (!(await canAutoOpen())) {
            await bridge.settle(panelId, command.id, {
              ok: false,
              error:
                '当前对话的右侧栏还没有网页，且插件设置里关闭了「自动打开面板」；请先手动打开「浏览器」标签页后重试',
            })
            return
          }
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
              target,
            )
          } catch (failure) {
            await bridge.settle(panelId, command.id, {
              ok: false,
              error: `无法自动打开侧边栏浏览器：${String(failure?.message ?? failure)}`,
            })
            return
          }
          element = await waitForGuest(8000, target)
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
          const value = await dispatch(element, command, target)
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
    return sessionViews(documentRef).find((view) => {
      if (typeof view.hasAttribute === 'function' && view.hasAttribute('hidden')) return false
      return typeof view.closest !== 'function' || view.closest('[hidden]') === null
    })
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
