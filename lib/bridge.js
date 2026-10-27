/**
 * BrowserBridge — the agent-facing half of the in-DSH browser.
 *
 * There is no external browser process and no screencast. The page is a real
 * Electron <webview> inside the DSH window (the shipped
 * `@deepseek-ai/dsh-client-ui-sidebar-browser` already provides the tab, the
 * address bar and the session). What that plugin cannot do is let the agent
 * touch the page: its main-process lease exposes navigation only.
 *
 * So the panel is the executor and this process is the caller. A tool call
 * enqueues a command, the panel polls for it (~50 ms), runs it against the guest
 * through an injected script, and posts the result back. That keeps DSH itself
 * unpatched and keeps every operation visible on screen: the agent and the human
 * drive the same page.
 */

/** One queued command waiting for the panel to pick it up. */
const COMMAND_TTL_MS = 60_000

/** How long a tool call waits for the panel before reporting that it is absent. */
const DEFAULT_TIMEOUT_MS = 30_000

export class BrowserBridge {
  /** @param {object} options */
  constructor(options = {}) {
    /** Monotonic id for commands and panel registrations. */
    this.#nextId = 1
    /** Commands not yet picked up, oldest first. */
    this.#pending = []
    /** Waiters parked by a long poll: {sessionId, wake}. */
    this.#pollWaiters = []
    /** Commands picked up but not yet answered: id -> record. */
    this.#inflight = new Map()
    /** Panels that have checked in: id -> lastSeenAt. */
    this.#panels = new Map()
    /** The conversation each panel is rendering: panelId -> sessionId. */
    this.#panelSessions = new Map()
    /** Called whenever a command resolves, so a waiter can be woken. */
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  #nextId
  #pending
  #pollWaiters
  #inflight
  #panels
  #panelSessions

  /**
   * Queue one command for the panel.
   *
   * @param {string} method command name understood by the injected script
   * @param {object} params command arguments
   * @param {{timeoutMs?: number, sensitive?: boolean, sessionId?: string, panelWaitMs?: number, waitForPanel?: boolean, openUrl?: string}} options
   * @returns {Promise<object>} the command result
   */
  async call(method, params = {}, options = {}) {
    this.#prune()

    const id = String(this.#nextId++)
    const record = {
      id,
      method,
      params,
      createdAt: Date.now(),
      /**
       * The conversation that asked for this command.
       *
       * DSH keeps one sidebar per Session, so a command must only ever be handed
       * to the panel rendering that same Session. Without this, switching chats
       * mid-request made the browser open in whichever chat was on screen.
       */
      sessionId: options.sessionId,
      resolve: undefined,
      reject: undefined,
      promise: undefined,
      sensitive: options.sensitive === true,
    }
    record.promise = new Promise((resolve, reject) => {
      record.resolve = resolve
      record.reject = reject
    })
    // Enqueue first, then check for a panel: a panel that opens during the wait
    // must find the command already queued, not race an empty queue.
    this.#pending.push(record)
    // A parked long poll may belong to the conversation that just asked.
    this.#wakePollers()

    // Wait only for a panel belonging to this conversation: another chat's panel
    // may be polling happily while this one has no sidebar at all.
    if (!this.attachedTo(options.sessionId) && options.waitForPanel !== false) {
      // The client bundle polls on its own and opens the sidebar browser when it
      // sees a queued command, so simply wait long enough for that round trip;
      // do not try to open a window from here, the sidebar is renderer-only.
      await this.#waitForPanel(options.panelWaitMs ?? 8000, options.sessionId)
      this.#prune()
    }
    if (!this.attachedTo(options.sessionId)) {
      const at = this.#pending.findIndex((entry) => entry.id === id)
      if (at !== -1) this.#pending.splice(at, 1)
      const error = new Error(
        options.sessionId === undefined
          ? 'DSH 右侧栏的浏览器面板没能打开。请确认 DSH 窗口在前台、右侧栏未被隐藏，然后重试'
          : '当前对话的浏览器面板没能打开。请在当前对话的右侧栏打开「浏览器」标签页后重试（不要切换到别的对话）',
      )
      error.code = 'PANEL_NOT_OPEN'
      throw error
    }

    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const timer = setTimeout(() => {
      this.#inflight.delete(id)
      const at = this.#pending.findIndex((entry) => entry.id === id)
      if (at !== -1) this.#pending.splice(at, 1)
      const error = new Error(`浏览器操作超时（${timeoutMs} ms）：${method}`)
      error.code = 'TIMEOUT'
      record.reject(error)
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    try {
      return await record.promise
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Hand the panel its next command, if any.
   *
   * A panel only ever receives commands belonging to its own conversation. A
   * command whose originating Session is unknown (an older caller, or a tool
   * invoked outside a chat) stays claimable by anyone, which keeps the simple
   * single-chat case working.
   *
   * @param {string} panelId stable id the panel generated for itself
   * @param {string} [sessionId] the conversation that panel is rendering
   * @returns {object|null} one command, or null when the queue is empty
   */
  poll(panelId, sessionId) {
    this.#prune()
    this.#panels.set(panelId, Date.now())
    if (sessionId !== undefined) this.#panelSessions.set(panelId, sessionId)

    const at = this.#pending.findIndex((entry) => {
      if (entry.sessionId === undefined) return true
      if (sessionId === undefined) return false
      return entry.sessionId === sessionId
    })
    if (at === -1) return null
    const [record] = this.#pending.splice(at, 1)
    this.#inflight.set(record.id, record)
    return {
      id: record.id,
      method: record.method,
      params: record.params,
      sensitive: record.sensitive,
      // Hand back the originating conversation so the panel can open the tab in
      // that chat even if the user has since switched away from it.
      ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
    }
  }

  /**
   * Long poll: resolve as soon as this conversation has work, or with null when
   * the wait expires.
   *
   * The pinned 50 ms poll turned every command into an average 25 ms of pure
   * latency and 20 HTTP requests per second per open panel. Parking the request
   * here keeps the same wire shape while removing both costs: a queued command
   * hands off on the next tick, and an idle panel is silent.
   *
   * @param {string} panelId stable id the panel generated for itself
   * @param {string} [sessionId] the conversation that panel is rendering
   * @param {number} [waitMs] how long to hold the request open
   * @returns {Promise<object|null>} one command, or null
   */
  async pollWait(panelId, sessionId, waitMs = 25_000) {
    const immediate = this.poll(panelId, sessionId)
    if (immediate !== null) return immediate
    this.#prune()
    await new Promise((resolve) => {
      const waiter = { sessionId, wake: () => { cleanup(); resolve() } }
      const timer = setTimeout(() => { cleanup(); resolve() }, Math.max(0, waitMs))
      if (typeof timer.unref === 'function') timer.unref()
      const cleanup = () => {
        clearTimeout(timer)
        const at = this.#pollWaiters.indexOf(waiter)
        if (at !== -1) this.#pollWaiters.splice(at, 1)
      }
      this.#pollWaiters.push(waiter)
    })
    // Lost race (the panel timed out as a command arrived): the command is
    // still queued, so this read simply reports "nothing yet" and the panel
    // asks again immediately.
    return this.poll(panelId, sessionId)
  }

  /** Wake every parked poll; a new command may belong to any conversation. */
  #wakePollers() {
    if (this.#pollWaiters.length === 0) return
    const waiters = this.#pollWaiters
    this.#pollWaiters = []
    for (const waiter of waiters) waiter.wake()
  }

  /**
   * Whether a conversation has a panel attached right now.
   *
   * @param {string} [sessionId]
   */
  attachedTo(sessionId) {
    if (sessionId === undefined) return this.attached
    this.#prune()
    for (const [panelId, seen] of this.#panels) {
      if (Date.now() - seen > COMMAND_TTL_MS) continue
      if (this.#panelSessions.get(panelId) === sessionId) return true
    }
    return false
  }

  /**
   * Accept the panel's answer to a command it picked up.
   *
   * @param {string} panelId
   * @param {string} id command id from poll()
   * @param {{ok: boolean, value?: unknown, error?: string}} outcome
   */
  settle(panelId, id, outcome) {
    this.#panels.set(panelId, Date.now())
    const record = this.#inflight.get(id)
    if (record === undefined) return { accepted: false }
    this.#inflight.delete(id)
    if (outcome?.ok === true) record.resolve(outcome.value)
    else {
      const error = new Error(String(outcome?.error ?? '浏览器操作失败'))
      error.code = 'PANEL_ERROR'
      record.reject(error)
    }
    return { accepted: true }
  }

  /** Panels currently polling, newest first. */
  panels() {
    this.#prune()
    return [...this.#panels.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([id, seenAt]) => ({ id, seenAt, ageMs: Date.now() - seenAt }))
  }

  /** True when at least one panel has checked in recently. */
  get attached() {
    this.#prune()
    return this.#panels.size > 0
  }

  /**
   * Wait for a panel to start polling.
   *
   * When a conversation is given, only that conversation's panel counts: another
   * chat's panel must not satisfy the wait, or a command would be handed to the
   * wrong sidebar.
   *
   * @param {number} ms
   * @param {string} [sessionId]
   */
  #waitForPanel(ms, sessionId) {
    if (ms <= 0) return Promise.resolve()
    return new Promise((resolve) => {
      const started = Date.now()
      const tick = () => {
        if (this.attachedTo(sessionId)) { resolve(); return }
        if (Date.now() - started >= ms) { resolve(); return }
        setTimeout(tick, 40)
      }
      setTimeout(tick, 40)
    })
  }

  /** Reject everything still queued; called when the plugin unloads. */
  close() {
    const error = new Error('浏览器桥接已关闭')
    error.code = 'CLOSED'
    const waiters = this.#pollWaiters
    this.#pollWaiters = []
    for (const waiter of waiters) waiter.wake()
    for (const record of this.#pending) record.reject(error)
    for (const record of this.#inflight.values()) record.reject(error)
    this.#pending.length = 0
    this.#inflight.clear()
    this.#panels.clear()
    this.#panelSessions.clear()
  }

  /**
   * Drop stale bookkeeping.
   *
   * Two things can leak here:
   *   - panels that stopped polling (a closed window must not look attached);
   *   - commands a panel picked up but never answered, e.g. because the page
   *     froze mid-script. Without this they stay `inflight` forever and the
   *     caller waits out its own timeout with no explanation.
   */
  #prune() {
    const now = Date.now()
    for (const [id, seenAt] of this.#panels) {
      if (now - seenAt > COMMAND_TTL_MS) {
        this.#panels.delete(id)
        this.#panelSessions.delete(id)
      }
    }
    for (const [id, record] of this.#inflight) {
      if (now - record.createdAt <= COMMAND_TTL_MS) continue
      this.#inflight.delete(id)
      const error = new Error(
        `页面没有响应这次操作（${record.method}）：页面可能卡住或已崩溃，可以调用 browser_reload 后重试`,
      )
      error.code = 'PAGE_UNRESPONSIVE'
      record.reject(error)
    }
  }
}
