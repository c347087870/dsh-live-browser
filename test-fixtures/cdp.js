/**
 * Minimal Chrome DevTools Protocol transport over a WebSocket.
 *
 * Two levels of messages share one socket:
 *  - browser-level commands (no sessionId),
 *  - page-level commands routed through a flattened Target session id.
 * Everything else the CDP server pushes is fanned out to listeners as
 * (method, params, sessionId).
 */

const DEFAULT_TIMEOUT_MS = 30_000

function wsCtor() {
  if (typeof WebSocket === 'function') return WebSocket
  throw new Error('global WebSocket is not available in this runtime')
}

export class CdpConnection {
  #ws
  #nextId = 0
  #pending = new Map()
  #listeners = new Set()
  #closed = false
  #closeReason

  constructor(ws) {
    this.#ws = ws
    ws.addEventListener('message', (event) => this.#onMessage(event))
    ws.addEventListener('close', () => this.#onClose())
    ws.addEventListener('error', () => this.#onClose('websocket error'))
  }

  /** Open a CDP WebSocket and resolve once the socket handshake finished. */
  static async connect(wsUrl, { timeoutMs = 15_000 } = {}) {
    const WS = wsCtor()
    const ws = new WS(wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP handshake timeout: ${wsUrl}`)), timeoutMs)
      const done = (error) => {
        clearTimeout(timer)
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onError)
        if (error) reject(error)
        else resolve()
      }
      const onOpen = () => done()
      const onError = () => done(new Error(`CDP websocket failed to open: ${wsUrl}`))
      ws.addEventListener('open', onOpen)
      ws.addEventListener('error', onError)
    })
    return new CdpConnection(ws)
  }

  get closed() {
    return this.#closed
  }

  /** Subscribe to protocol events. Returns an unsubscribe function. */
  on(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Send one command; resolves with the CDP `result` object. */
  send(method, params = {}, sessionId, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.#closed) {
      return Promise.reject(new Error(`CDP connection closed${this.#closeReason ? `: ${this.#closeReason}` : ''}`))
    }
    const id = ++this.#nextId
    const payload = { id, method, params }
    if (sessionId !== undefined && sessionId !== null) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`CDP command timed out (${timeoutMs} ms): ${method}`))
      }, Math.max(1000, timeoutMs))
      this.#pending.set(id, { resolve, reject, timer, method })
      try {
        this.#ws.send(JSON.stringify(payload))
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(error)
      }
    })
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    try {
      this.#ws.close()
    } catch {
      /* already gone */
    }
    this.#rejectAll(new Error('CDP connection closed'))
  }

  #onMessage(event) {
    let message
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch {
      return
    }
    if (message.id !== undefined) {
      const entry = this.#pending.get(message.id)
      if (entry === undefined) return
      this.#pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        const error = new Error(`CDP ${entry.method} failed: ${message.error.message ?? 'unknown error'}`)
        error.code = message.error.code
        error.data = message.error.data
        entry.reject(error)
      } else {
        entry.resolve(message.result ?? {})
      }
      return
    }
    if (typeof message.method !== 'string') return
    for (const listener of this.#listeners) {
      try {
        listener(message.method, message.params ?? {}, message.sessionId)
      } catch {
        /* a listener must never break the transport */
      }
    }
  }

  #onClose(reason) {
    if (this.#closed) return
    this.#closed = true
    this.#closeReason = reason
    this.#rejectAll(new Error(`CDP connection closed${reason ? `: ${reason}` : ''}`))
  }

  #rejectAll(error) {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.#pending.clear()
  }
}

/** GET a DevTools HTTP endpoint (e.g. /json/version) with a hard timeout. */
export async function fetchJson(url, timeoutMs = 3000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/** Probe a remote-debugging port. Returns the version record or undefined. */
export async function probeCdp(port, host = '127.0.0.1', timeoutMs = 1500) {
  try {
    const version = await fetchJson(`http://${host}:${port}/json/version`, timeoutMs)
    if (typeof version?.webSocketDebuggerUrl === 'string') return version
    return undefined
  } catch {
    return undefined
  }
}
