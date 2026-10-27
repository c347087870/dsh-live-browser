/**
 * Page-level browser driver on top of the CDP transport.
 *
 * One BrowserHub owns the single connection to the plugin's browser process and
 * multiplexes every tab through flattened target sessions. Tools and the panel
 * RPC share it, so an agent action and a human click hit the same page.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CdpConnection } from './cdp.js'

export const NO_BROWSER = 'BROWSER_NOT_RUNNING'

/** Roles worth surfacing to the model as interactive or readable nodes. */
const INTERESTING_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider',
  'spinbutton', 'textarea', 'heading', 'img', 'cell', 'columnheader', 'rowheader',
  'listitem', 'paragraph', 'label', 'dialog', 'alertdialog', 'alert', 'status',
])

const ACTIONABLE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider',
  'spinbutton', 'textarea',
])

const KEY_CODES = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Best-effort normalisation of user-typed addresses. */
export function normalizeUrl(input) {
  const raw = String(input ?? '').trim()
  if (raw === '') return 'about:blank'
  if (/^(https?:|file:|data:|about:|chrome:)/i.test(raw)) return raw
  if (/^localhost(:\d+)?(\/|$)/i.test(raw) || /^127\.0\.0\.1(:\d+)?/.test(raw)) return `http://${raw}`
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(raw)) return `https://${raw}`
  return `https://www.bing.com/search?q=${encodeURIComponent(raw)}`
}

export class BrowserHub {
  constructor(cfg, launcher, logger) {
    this.cfg = cfg
    this.launcher = launcher
    this.logger = logger
    this.conn = undefined
    this.tabs = new Map()
    this.refs = new Map()
    this.activeTargetId = undefined
    this.connecting = undefined
    this.frameSeq = 0
  }

  /* ------------------------------------------------------------------ */
  /* connection + targets                                               */
  /* ------------------------------------------------------------------ */

  async ensure() {
    if (this.conn !== undefined && !this.conn.closed) return this.conn
    if (this.connecting !== undefined) return this.connecting
    this.connecting = (async () => {
      const version = await this.launcher.probe()
      if (version === undefined) {
        const error = new Error(
          `浏览器没有在调试端口 ${this.cfg.debugPort} 上运行。请先在「浏览器」面板点「接管 Chrome」，或调用 browser_launch。`,
        )
        error.code = NO_BROWSER
        throw error
      }
      const conn = await CdpConnection.connect(version.webSocketDebuggerUrl)
      this.conn = conn
      conn.on((method, params, sessionId) => this.#onEvent(method, params, sessionId))
      await conn.send('Target.setDiscoverTargets', { discover: true })
      try {
        await conn.send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: this.downloadDir,
          eventsEnabled: true,
        })
      } catch {
        /* older builds: ignore */
      }
      const { targetInfos } = await conn.send('Target.getTargets')
      for (const info of targetInfos) {
        if (info.type === 'page') await this.#attach(info.targetId, info)
      }
      if (this.activeTargetId === undefined && this.tabs.size > 0) {
        this.activeTargetId = [...this.tabs.keys()][0]
      }
      return conn
    })()
    try {
      return await this.connecting
    } finally {
      this.connecting = undefined
    }
  }

  async #attach(targetId, info) {
    const existing = this.tabs.get(targetId)
    if (existing !== undefined) return existing
    const conn = this.conn
    if (conn === undefined) throw new Error('CDP connection is not open')
    let sessionId
    try {
      const attached = await conn.send('Target.attachToTarget', { targetId, flatten: true })
      sessionId = attached.sessionId
    } catch (error) {
      this.logger?.warn?.(`[dsh-live-browser] attach failed for ${targetId}: ${error.message}`)
      return undefined
    }
    const tab = {
      targetId,
      sessionId,
      url: info?.url ?? 'about:blank',
      title: info?.title ?? '',
      frame: undefined,
      screencasting: false,
    }
    this.tabs.set(targetId, tab)
    for (const domain of ['Page', 'Runtime', 'DOM', 'Network']) {
      try {
        await conn.send(`${domain}.enable`, {}, sessionId)
      } catch {
        /* some domains are unavailable on special targets */
      }
    }
    return tab
  }

  #onEvent(method, params, sessionId) {
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      const info = params.targetInfo
      if (info === undefined || info.type !== 'page') return
      const tab = this.tabs.get(info.targetId)
      if (tab === undefined) {
        if (method === 'Target.targetCreated') {
          void this.#attach(info.targetId, info).catch(() => {})
        }
        return
      }
      tab.url = info.url ?? tab.url
      tab.title = info.title ?? tab.title
      return
    }
    if (method === 'Target.targetDestroyed') {
      this.tabs.delete(params.targetId)
      if (this.activeTargetId === params.targetId) {
        this.activeTargetId = this.tabs.size > 0 ? [...this.tabs.keys()][0] : undefined
      }
      return
    }
    const tab = sessionId === undefined ? undefined : this.#tabBySession(sessionId)
    if (tab === undefined) return
    switch (method) {
      case 'Page.frameNavigated': {
        if (params.frame?.parentId === undefined || params.frame.parentId === null) {
          tab.url = params.frame.url ?? tab.url
          this.refs.delete(tab.targetId)
        }
        return
      }
      case 'Page.screencastFrame': {
        tab.frame = {
          data: params.data,
          seq: ++this.frameSeq,
          timestamp: params.metadata?.timestamp ?? Date.now() / 1000,
          width: params.metadata?.deviceWidth,
          height: params.metadata?.deviceHeight,
        }
        void this.conn?.send('Page.screencastFrameAck', { sessionId: params.sessionId }, tab.sessionId).catch(() => {})
        return
      }
      case 'Page.javascriptDialogOpening': {
        // Auto-dismiss would hide intent; leave dialogs to the human and note them.
        tab.dialog = { type: params.type, message: params.message }
        return
      }
      default:
        return
    }
  }

  #tabBySession(sessionId) {
    for (const tab of this.tabs.values()) {
      if (tab.sessionId === sessionId) return tab
    }
    return undefined
  }

  get downloadDir() {
    return this.cfg.downloadDir ?? join(process.cwd(), 'downloads')
  }

  async send(tab, method, params = {}, timeoutMs) {
    await this.ensure()
    if (tab === undefined) throw new Error('标签页不存在')
    return this.conn.send(method, params, tab.sessionId, timeoutMs)
  }

  /**
   * Bring a tab to the foreground before dispatching input.
   *
   * Input events are only delivered reliably to the visible tab: a background
   * target accepts them but never acks, which surfaces as a CDP timeout. The
   * plugin's own `activeTargetId` cannot be trusted here because the user can
   * switch tabs in the browser window at any time, and CDP exposes no cheap,
   * reliable "is this tab frontmost" flag — so activate unconditionally. It is
   * one command and the page must be visible for input to work at all.
   */
  async focus(tab) {
    if (tab === undefined) return
    this.activeTargetId = tab.targetId
    await this.conn.send('Target.activateTarget', { targetId: tab.targetId }).catch(() => {})
    // Let the compositor make the tab visible before the input arrives.
    await sleep(120)
  }

  async listTabs() {
    await this.ensure()
    const conn = this.conn
    const { targetInfos } = await conn.send('Target.getTargets')
    const pages = []
    for (const info of targetInfos) {
      if (info.type !== 'page') continue
      if (!this.tabs.has(info.targetId)) await this.#attach(info.targetId, info)
      const tab = this.tabs.get(info.targetId)
      pages.push({
        targetId: info.targetId,
        title: info.title ?? tab?.title ?? '',
        url: info.url ?? tab?.url ?? '',
        active: info.targetId === this.activeTargetId,
      })
    }
    return pages
  }

  async resolveTab(targetId) {
    await this.ensure()
    if (targetId !== undefined && targetId !== null && targetId !== '') {
      const tab = this.tabs.get(targetId)
      if (tab === undefined) throw new Error(`未知标签页：${targetId}（先调用 browser_tabs 查看）`)
      return tab
    }
    if (this.activeTargetId === undefined) {
      const conn = this.conn
      const { targetInfos } = await conn.send('Target.getTargets')
      const first = targetInfos.find((info) => info.type === 'page')
      if (first === undefined) throw new Error('没有可用的标签页，先调用 browser_tab 新建一个')
      await this.#attach(first.targetId, first)
      this.activeTargetId = first.targetId
    }
    return this.tabs.get(this.activeTargetId)
  }

  async newTab(url = 'about:blank', { activate = true } = {}) {
    const version = await this.launcher.probe()
    if (version === undefined) {
      const error = new Error('浏览器没有运行，先调用 browser_launch 接管 Chrome')
      error.code = NO_BROWSER
      throw error
    }
    // Reuse the HTTP endpoint instead of Target.createTarget so the tab opens in
    // the browser's own window and inherits its profile state.
    const target = await this.#httpNewTab(normalizeUrl(url))
    await this.ensure()
    const tab = await this.#attach(target.id, { url: target.url, title: target.title })
    if (activate) {
      this.activeTargetId = target.id
      await this.conn.send('Target.activateTarget', { targetId: target.id }).catch(() => {})
    }
    if (tab !== undefined && url !== 'about:blank') await this.waitForLoad(tab, 15_000).catch(() => {})
    return this.listTabs()
  }

  async #httpNewTab(url) {
    const response = await fetch(`http://127.0.0.1:${this.cfg.debugPort}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT',
    })
    if (!response.ok) throw new Error(`新建标签页失败：HTTP ${response.status}`)
    return await response.json()
  }

  async closeTab(targetId) {
    await this.ensure()
    await this.conn.send('Target.closeTarget', { targetId })
    this.tabs.delete(targetId)
    if (this.activeTargetId === targetId) {
      this.activeTargetId = this.tabs.size > 0 ? [...this.tabs.keys()][0] : undefined
    }
    return this.listTabs()
  }

  async activateTab(targetId) {
    await this.ensure()
    const tab = await this.resolveTab(targetId)
    this.activeTargetId = tab.targetId
    await this.conn.send('Target.activateTarget', { targetId: tab.targetId }).catch(() => {})
    return { active: tab.targetId, url: tab.url }
  }

  /* ------------------------------------------------------------------ */
  /* navigation                                                         */
  /* ------------------------------------------------------------------ */

  async navigate(targetId, url, { waitMs = 20_000, timeoutMs } = {}) {
    const tab = await this.resolveTab(targetId)
    const target = normalizeUrl(url)
    this.refs.delete(tab.targetId)
    const timeout = timeoutMs ?? waitMs
    const nav = this.send(tab, 'Page.navigate', { url: target }, timeout + 5_000)
    await nav.catch(async (error) => {
      // A download or an aborted navigation rejects the command while the page
      // still changed; fall back to reading the live state.
      this.logger?.debug?.(`[dsh-live-browser] navigate: ${error.message}`)
    })
    await this.waitForLoad(tab, timeout).catch(() => {})
    return await this.state(tab)
  }

  async waitForLoad(tab, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const { result } = await this.send(tab, 'Runtime.evaluate', {
          expression: 'document.readyState + "|" + location.href',
          returnByValue: true,
        })
        const [ready, href] = String(result.value ?? '').split('|')
        if (ready === 'complete' && href !== 'about:blank') return true
      } catch {
        /* frame may be navigating */
      }
      await sleep(150)
    }
    return false
  }

  async back(targetId) {
    const tab = await this.resolveTab(targetId)
    await this.send(tab, 'Runtime.evaluate', { expression: 'history.back()' })
    await sleep(400)
    await this.waitForLoad(tab, 15_000).catch(() => {})
    return await this.state(tab)
  }

  async forward(targetId) {
    const tab = await this.resolveTab(targetId)
    await this.send(tab, 'Runtime.evaluate', { expression: 'history.forward()' })
    await sleep(400)
    await this.waitForLoad(tab, 15_000).catch(() => {})
    return await this.state(tab)
  }

  async reload(targetId) {
    const tab = await this.resolveTab(targetId)
    await this.send(tab, 'Page.reload', {})
    await this.waitForLoad(tab, 20_000).catch(() => {})
    return await this.state(tab)
  }

  async state(tab) {
    let url = tab.url
    let title = tab.title
    let viewport = undefined
    try {
      const { result } = await this.send(tab, 'Runtime.evaluate', {
        expression:
          'JSON.stringify({url: location.href, title: document.title, w: innerWidth, h: innerHeight, sx: scrollX, sy: scrollY, dh: document.documentElement.scrollHeight})',
        returnByValue: true,
      })
      const parsed = JSON.parse(String(result.value))
      url = parsed.url
      title = parsed.title
      viewport = { width: parsed.w, height: parsed.h, scrollX: parsed.sx, scrollY: parsed.sy, scrollHeight: parsed.dh }
      tab.url = url
      tab.title = title
    } catch {
      /* page may be mid-navigation */
    }
    return { targetId: tab.targetId, url, title, viewport }
  }

  /* ------------------------------------------------------------------ */
  /* reading the page                                                   */
  /* ------------------------------------------------------------------ */

  async snapshot(targetId, { maxNodes = 400 } = {}) {
    const tab = await this.resolveTab(targetId)
    await this.send(tab, 'Accessibility.enable').catch(() => {})
    const { nodes } = await this.send(tab, 'Accessibility.getFullAXTree', {})
    const byId = new Map()
    for (const node of nodes) byId.set(node.nodeId, node)

    const refs = new Map()
    const rows = []
    let counter = 0

    const visit = (node, depth) => {
      if (rows.length >= maxNodes) return
      if (node === undefined || node.ignored === true) {
        for (const childId of node?.childIds ?? []) visit(byId.get(childId), depth)
        return
      }
      const role = node.role?.value
      const name = (node.name?.value ?? '').trim()
      const value = node.value?.value
      const props = new Map((node.properties ?? []).map((entry) => [entry.name, entry.value?.value]))
      const interesting =
        (role !== undefined && INTERESTING_ROLES.has(String(role))) ||
        (role === 'generic' && name !== '') ||
        (role !== undefined && role !== 'none' && name !== '' && depth < 6)

      let childDepth = depth
      if (interesting && (name !== '' || ACTIONABLE_ROLES.has(String(role)))) {
        const ref = `e${++counter}`
        rows.push({
          ref,
          role: String(role),
          name: name.slice(0, 200),
          ...(value !== undefined && value !== '' ? { value: String(value).slice(0, 200) } : {}),
          ...(props.get('disabled') === true ? { disabled: true } : {}),
          ...(props.get('checked') !== undefined ? { checked: props.get('checked') } : {}),
          ...(props.get('focused') === true ? { focused: true } : {}),
          actionable: ACTIONABLE_ROLES.has(String(role)),
          depth: Math.min(depth, 12),
        })
        if (node.backendDOMNodeId !== undefined) refs.set(ref, node.backendDOMNodeId)
        childDepth = depth + 1
      }
      for (const childId of node.childIds ?? []) visit(byId.get(childId), childDepth)
    }
    visit(nodes.find((node) => node.parentId === undefined) ?? nodes[0], 0)

    this.refs.set(tab.targetId, refs)
    const info = await this.state(tab)
    return {
      that: undefined,
      ...info,
      nodes: rows,
      text: renderSnapshotText(info, rows, counter),
    }
  }

  /** Visible text of the page, collapsed and capped. */
  async readText(targetId, { maxChars = 12_000, selector } = {}) {
    const tab = await this.resolveTab(targetId)
    const expression = selector
      ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.innerText : '' })()`
      : 'document.body ? document.body.innerText : ""'
    const { result } = await this.send(tab, 'Runtime.evaluate', { expression, returnByValue: true })
    const text = String(result.value ?? '')
    const collapsed = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
    return {
      ...(await this.state(tab)),
      chars: collapsed.length,
      truncated: collapsed.length > maxChars,
      text: collapsed.slice(0, maxChars),
    }
  }

  async evalJs(targetId, expression, { awaitPromise = true } = {}) {
    const tab = await this.resolveTab(targetId)
    const { result, exceptionDetails } = await this.send(tab, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    })
    if (exceptionDetails !== undefined) {
      return { ok: false, error: exceptionDetails.exception?.description ?? exceptionDetails.text }
    }
    return { ok: true, value: result.value ?? result.description ?? null }
  }

  /* ------------------------------------------------------------------ */
  /* acting on the page                                                 */
  /* ------------------------------------------------------------------ */

  #refOf(tab, ref) {
    const map = this.refs.get(tab.targetId)
    const backendNodeId = map?.get(ref)
    if (backendNodeId === undefined) {
      throw new Error(`无效的引用 ${ref}：请先调用 browser_snapshot 获取当前页面的 ref`)
    }
    return backendNodeId
  }

  async #centerOf(tab, backendNodeId) {
    await this.send(tab, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {})
    let quads
    try {
      ({ quads } = await this.send(tab, 'DOM.getContentQuads', { backendNodeId }))
    } catch {
      const { model } = await this.send(tab, 'DOM.getBoxModel', { backendNodeId })
      quads = [model.content]
    }
    if (quads === undefined || quads.length === 0) throw new Error('元素不可见或尺寸为零，无法点击')
    const quad = quads[0]
    let x = 0
    let y = 0
    for (let i = 0; i < quad.length; i += 2) {
      x += quad[i]
      y += quad[i + 1]
    }
    return { x: x / (quad.length / 2), y: y / (quad.length / 2) }
  }

  async click(targetId, { ref, selector, x, y, button = 'left', clickCount = 1 } = {}) {
    const tab = await this.resolveTab(targetId)
    await this.focus(tab)
    let point
    if (x !== undefined && y !== undefined) {
      point = { x, y }
    } else if (ref !== undefined) {
      point = await this.#centerOf(tab, this.#refOf(tab, ref))
    } else if (selector !== undefined) {
      const found = await this.send(tab, 'Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}) })()`,
        returnByValue: true,
      })
      if (found.result.value === null || found.result.value === undefined) {
        throw new Error(`没有找到选择器 ${selector} 匹配的元素`)
      }
      point = JSON.parse(String(found.result.value))
    } else {
      throw new Error('click 需要 ref、selector 或坐标')
    }
    const common = { x: point.x, y: point.y, button, clickCount, buttons: button === 'left' ? 1 : 2 }
    await this.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await this.send(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...common })
    await this.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...common })
    await sleep(120)
    return { clicked: point, ...(await this.state(tab)) }
  }

  async hover(targetId, { ref, selector, x, y }) {
    const tab = await this.resolveTab(targetId)
    await this.focus(tab)
    let point
    if (x !== undefined && y !== undefined) point = { x, y }
    else if (ref !== undefined) point = await this.#centerOf(tab, this.#refOf(tab, ref))
    else if (selector !== undefined) {
      const found = await this.send(tab, 'Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}) })()`,
        returnByValue: true,
      })
      if (found.result.value == null) throw new Error(`没有找到选择器 ${selector} 匹配的元素`)
      point = JSON.parse(String(found.result.value))
    } else throw new Error('hover 需要 ref、selector 或坐标')
    await this.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    return { hovered: point }
  }

  async type(targetId, { ref, selector, text, clear = true, submit = false } = {}) {
    const tab = await this.resolveTab(targetId)
    await this.focus(tab)
    if (ref !== undefined || selector !== undefined) {
      if (ref !== undefined) {
        await this.send(tab, 'DOM.focus', { backendNodeId: this.#refOf(tab, ref) }).catch(async () => {
          await this.click(targetId, { ref })
        })
      } else {
        const focused = await this.send(tab, 'Runtime.evaluate', {
          expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return true })()`,
          returnByValue: true,
        })
        if (focused.result.value !== true) throw new Error(`没有找到选择器 ${selector} 匹配的元素`)
      }
    }
    if (clear) {
      await this.send(tab, 'Runtime.evaluate', {
        expression:
          '(() => { const el = document.activeElement; if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) { el.select && el.select(); } return true })()',
      })
      await this.send(tab, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
      })
      await this.send(tab, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
      })
    }
    if (text !== undefined && text !== '') {
      await this.send(tab, 'Input.insertText', { text: String(text) })
    }
    if (submit) await this.press(targetId, 'Enter')
    await sleep(120)
    const value = await this.send(tab, 'Runtime.evaluate', {
      expression: '(() => { const el = document.activeElement; return el && "value" in el ? String(el.value).slice(0,200) : "" })()',
      returnByValue: true,
    })
    return { typed: String(text ?? '').length, activeValue: String(value.result.value ?? ''), ...(await this.state(tab)) }
  }

  async press(targetId, key) {
    const tab = await this.resolveTab(targetId)
    await this.focus(tab)
    const spec = KEY_CODES[key]
    if (spec === undefined) {
      // Printable single character: insert it directly.
      if (typeof key === 'string' && key.length === 1) {
        await this.send(tab, 'Input.insertText', { text: key })
        return { pressed: key }
      }
      throw new Error(`不支持的按键：${key}`)
    }
    await this.send(tab, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
    })
    if (spec.text !== undefined) {
      await this.send(tab, 'Input.dispatchKeyEvent', {
        type: 'char', key: spec.key, text: spec.text, unmodifiedText: spec.text,
      })
    }
    await this.send(tab, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
    })
    await sleep(80)
    return { pressed: key }
  }

  async selectOption(targetId, { ref, selector, value, label }) {
    const tab = await this.resolveTab(targetId)
    await this.focus(tab)
    const expression = `(() => {
      const el = ${ref !== undefined ? `(() => { return null })()` : `document.querySelector(${JSON.stringify(selector ?? '')})`};
      return el ? true : false
    })()`
    if (ref !== undefined) {
      // Native <select> elements are best driven through their own value setter.
      const node = await this.send(tab, 'DOM.resolveNode', { backendNodeId: this.#refOf(tab, ref) })
      const call = await this.send(tab, 'Runtime.callFunctionOn', {
        objectId: node.object.objectId,
        functionDeclaration: `function(value, label) {
          if (this.tagName !== 'SELECT') return { ok: false, error: 'not a select element: ' + this.tagName };
          const options = [...this.options];
          const match = options.find((o) => (value != null && o.value === value) || (label != null && o.text.trim() === label));
          if (!match) return { ok: false, error: 'option not found', options: options.slice(0, 20).map((o) => o.value + ' | ' + o.text.trim()) };
          this.value = match.value;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, value: this.value };
        }`,
        arguments: [{ value: value ?? null }, { value: label ?? null }],
        returnByValue: true,
      })
      return { ...(await this.state(tab)), result: call.result.value }
    }
    void expression
    const call = await this.send(tab, 'Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector ?? '')});
        if (!el) return { ok: false, error: 'selector not found' };
        if (el.tagName !== 'SELECT') return { ok: false, error: 'not a select: ' + el.tagName };
        const options = [...el.options];
        const match = options.find((o) => (${JSON.stringify(value ?? null)} != null && o.value === ${JSON.stringify(value ?? null)}) || (${JSON.stringify(label ?? null)} != null && o.text.trim() === ${JSON.stringify(label ?? null)}));
        if (!match) return { ok: false, error: 'option not found', options: options.slice(0, 20).map((o) => o.value + ' | ' + o.text.trim()) };
        el.value = match.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: el.value };
      })()`,
      returnByValue: true,
    })
    return { ...(await this.state(tab)), result: call.result.value }
  }

  /**
   * Scroll the page.
   *
   * `Input.dispatchMouseEvent{mouseWheel}` waits for the compositor's ack, which
   * never arrives for some pages (notably ones with a scroll-snap container or
   * while the tab is not composited); it then hangs until the CDP timeout. The
   * gesture API is answered by the input pipeline instead, so it is the primary
   * path, with a DOM scroll fallback when the page has no gesture target.
   */
  async scroll(targetId, { dy = 0, dx = 0, ref } = {}) {
    const tab = await this.resolveTab(targetId)
    await this.focus(tab)
    let point = { x: 400, y: 400 }
    if (ref !== undefined) point = await this.#centerOf(tab, this.#refOf(tab, ref))
    try {
      await this.send(tab, 'Input.synthesizeScrollGesture', {
        x: Math.round(point.x),
        y: Math.round(point.y),
        xDistance: -Math.round(dx),
        yDistance: -Math.round(dy),
        speed: 800,
        gestureSourceType: 'mouse',
      }, 8_000)
    } catch {
      await this.send(tab, 'Runtime.evaluate', {
        expression: `window.scrollBy(${Number(dx) || 0}, ${Number(dy) || 0})`,
      })
    }
    await sleep(250)
    return await this.state(tab)
  }

  async uploadFile(targetId, { ref, selector, files }) {
    const tab = await this.resolveTab(targetId)
    let backendNodeId
    if (ref !== undefined) backendNodeId = this.#refOf(tab, ref)
    else {
      const { root } = await this.send(tab, 'DOM.getDocument', { depth: -1, pierce: true })
      const { nodeId } = await this.send(tab, 'DOM.querySelector', {
        nodeId: root.nodeId,
        selector: selector ?? 'input[type=file]',
      })
      if (nodeId === 0) throw new Error(`没有找到文件输入框：${selector ?? 'input[type=file]'}`)
      const { node } = await this.send(tab, 'DOM.describeNode', { nodeId })
      backendNodeId = node.backendNodeId
    }
    await this.send(tab, 'DOM.setFileInputFiles', { files, backendNodeId })
    return { ...(await this.state(tab)), uploaded: files }
  }

  async waitFor(targetId, { selector, text, timeoutMs = 15_000, state = 'visible' } = {}) {
    const tab = await this.resolveTab(targetId)
    const deadline = Date.now() + timeoutMs
    const expression = selector !== undefined
      ? `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          if (${JSON.stringify(state)} === 'attached') return true;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })()`
      : `(() => document.body && document.body.innerText.includes(${JSON.stringify(text ?? '')}))()`
    while (Date.now() < deadline) {
      try {
        const { result } = await this.send(tab, 'Runtime.evaluate', { expression, returnByValue: true })
        if (result.value === true) return { matched: true, waitedMs: timeoutMs - (deadline - Date.now()) }
      } catch {
        /* navigating */
      }
      await sleep(200)
    }
    return { matched: false, waitedMs: timeoutMs }
  }

  /* ------------------------------------------------------------------ */
  /* screenshots + panel stream                                          */
  /* ------------------------------------------------------------------ */

  async screenshot(targetId, { format = 'jpeg', quality = 80, fullPage = false } = {}) {
    const tab = await this.resolveTab(targetId)
    const params = { format, ...(format === 'jpeg' ? { quality } : {}), captureBeyondViewport: fullPage }
    if (fullPage) {
      const { result } = await this.send(tab, 'Runtime.evaluate', {
        expression: 'JSON.stringify({w: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth), h: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)})',
        returnByValue: true,
      })
      const size = JSON.parse(String(result.value))
      params.clip = { x: 0, y: 0, width: size.w, height: size.h, scale: 1 }
    }
    const { data } = await this.send(tab, 'Page.captureScreenshot', params, 30_000)
    return { data, format, bytes: Math.floor((data.length * 3) / 4) }
  }

  /** Save a screenshot to disk (durable evidence for the model / user). */
  async saveScreenshot(targetId, dir, { format = 'png', quality, prefix = 'page' } = {}) {
    mkdirSync(dir, { recursive: true })
    const shot = await this.screenshot(targetId, { format, quality })
    const ext = format === 'jpeg' ? 'jpg' : 'png'
    const path = join(dir, `${prefix}-${Date.now()}.${ext}`)
    writeFileSync(path, Buffer.from(shot.data, 'base64'))
    return { path, bytes: shot.bytes, format }
  }

  async startScreencast(targetId, { quality = 55, maxWidth = 1280, maxHeight = 800 } = {}) {
    const tab = await this.resolveTab(targetId)
    if (tab.screencasting) return { streaming: true, targetId: tab.targetId }
    await this.send(tab, 'Page.startScreencast', {
      format: 'jpeg', quality, maxWidth, maxHeight, everyNthFrame: 1,
    })
    tab.screencasting = true
    return { streaming: true, targetId: tab.targetId }
  }

  async stopScreencast(targetId) {
    const tab = await this.resolveTab(targetId)
    if (!tab.screencasting) return { streaming: false }
    await this.send(tab, 'Page.stopScreencast', {}).catch(() => {})
    tab.screencasting = false
    tab.frame = undefined
    return { streaming: false }
  }

  /** Latest streamed frame, or a fresh still when nothing arrived yet. */
  async latestFrame(targetId, { sinceSeq = 0 } = {}) {
    if (this.launcher === undefined) return undefined
    const tab = await this.resolveTab(targetId)
    if (!tab.screencasting) await this.startScreencast(targetId)
    if (tab.frame !== undefined && tab.frame.seq > sinceSeq) {
      return { seq: tab.frame.seq, dataUrl: `data:image/jpeg;base64,${tab.frame.data}` }
    }
    if (sinceSeq === 0) {
      const shot = await this.screenshot(targetId, { format: 'jpeg', quality: 55 })
      return { seq: tab.frame?.seq ?? 0, dataUrl: `data:image/jpeg;base64,${shot.data}` }
    }
    return undefined
  }

  async close() {
    const conn = this.conn
    this.conn = undefined
    this.tabs.clear()
    this.refs.clear()
    this.activeTargetId = undefined
    if (conn !== undefined) await conn.close().catch(() => {})
  }
}

function renderSnapshotText(info, rows, count) {
  const header = `URL: ${info.url}\nTITLE: ${info.title}\nVIEWPORT: ${info.viewport ? `${info.viewport.width}x${info.viewport.height} @${Math.round(info.viewport.scrollY)}` : 'unknown'}\nNODES: ${count}`
  const body = rows
    .map((row) => {
      const indent = '  '.repeat(row.depth)
      const flags = [
        row.disabled ? 'disabled' : '',
        row.checked !== undefined ? `checked=${row.checked}` : '',
        row.focused ? 'focused' : '',
      ].filter(Boolean).join(' ')
      const value = row.value !== undefined ? ` value="${row.value}"` : ''
      return `${indent}[${row.ref}] ${row.role} "${row.name}"${value}${flags ? ` (${flags})` : ''}`
    })
    .join('\n')
  return `${header}\n\n${body}`
}
