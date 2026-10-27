/**
 * The script injected into each browser guest page.
 *
 * It is serialized into the guest through `<webview>.executeJavaScript()`, so
 * this file must evaluate standalone inside a page: no imports, no closures over
 * plugin state. It installs one global (`__dshBrowserAgent`) exposing the
 * primitive the panel calls per command.
 *
 * Everything here runs *in the page*, so it uses DOM APIs only. Coordinates are
 * CSS pixels in the page's own viewport, matching what a human sees.
 */

export const AGENT_GLOBAL = '__dshBrowserAgent'

/** Accessibility-ish view of one element, used to give the model stable refs. */
const SNAPSHOT_HELPERS = /* js */ `
  const INTERACTIVE = new Set([
    'A','BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY','OPTION','LABEL'
  ])
  const ROLE_BY_TAG = {
    A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox',
    TEXTAREA: 'textbox', IMG: 'img', H1: 'heading', H2: 'heading', H3: 'heading',
    H4: 'heading', H5: 'heading', H6: 'heading', UL: 'list', OL: 'list',
    LI: 'listitem', TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader',
    NAV: 'navigation', MAIN: 'main', ASIDE: 'complementary', HEADER: 'banner',
    FOOTER: 'contentinfo', FORM: 'form', DIALOG: 'dialog', P: 'paragraph'
  }

  const roleOf = (element) => {
    const explicit = element.getAttribute && element.getAttribute('role')
    if (explicit) return explicit
    if (element.tagName === 'INPUT') {
      const type = (element.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button'
      if (type === 'search') return 'searchbox'
      if (type === 'number') return 'spinbutton'
      if (type === 'range') return 'slider'
      return 'textbox'
    }
    return ROLE_BY_TAG[element.tagName] || element.tagName.toLowerCase()
  }

  const accessibleName = (element) => {
    const aria = element.getAttribute && (element.getAttribute('aria-label') || element.getAttribute('aria-labelledby'))
    if (aria) return aria
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      if (element.labels && element.labels.length > 0) return (element.labels[0].innerText || '').trim()
      return (element.getAttribute('placeholder') || element.getAttribute('title') || '').trim()
    }
    if (element.tagName === 'IMG') return (element.getAttribute('alt') || '').trim()
    return (element.innerText || element.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120)
  }

  /**
   * Whether an element has any painted box.
   *
   * A zero-height block still reports a non-zero width, so both dimensions must
   * be checked: otherwise an empty wrapper looks visible to a caller that asked
   * to wait until something is actually on screen.
   */
  const isVisible = (element) => {
    if (!element.isConnected) return false
    const style = getComputedStyle(element)
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    return true
  }

  const clickable = (element) => element.closest(
    'a,button,input,select,textarea,summary,label,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[onclick]'
  )

  /** Stable ref per element for the lifetime of one snapshot. */
  const refFor = (element) => {
    if (!element.__dshRef) {
      const next = (window.__dshRefSeq = (window.__dshRefSeq || 0) + 1)
      element.__dshRef = 'e' + next
      ;(window.__dshRefs = window.__dshRefs || {})[element.__dshRef] = element
    }
    return element.__dshRef
  }

  /**
   * Drop the previous snapshot's refs.
   *
   * A ref is documented as valid for one snapshot, and a page holds its own refs
   * alive: without this, every element ever snapshotted stayed reachable from
   * window.__dshRefs, so a long-lived single-page app leaked every node it had
   * ever shown. Clearing on the next snapshot keeps the documented lifetime and
   * bounds the map to one snapshot's worth of nodes.
   */
  const resetRefs = () => {
    const previous = window.__dshRefs
    if (previous) {
      for (const element of Object.values(previous)) {
        if (element && typeof element === 'object') element.__dshRef = undefined
      }
    }
    window.__dshRefs = {}
    window.__dshRefSeq = 0
  }

  const elementFor = (ref) => {
    const found = (window.__dshRefs || {})[ref]
    // A ref outlives the node it pointed at: single-page apps re-render constantly,
    // so an old ref may resolve to a detached element. Acting on that would
    // silently succeed against invisible DOM, which is worse than an error.
    if (found === undefined) return undefined
    if (found.isConnected !== true) return undefined
    // Also reject a node that belongs to a previous document instance (a
    // same-origin navigation can leave an element object alive but orphaned).
    if (found.ownerDocument !== document) return undefined
    return found
  }

  const buildSnapshot = (maxNodes) => {
    resetRefs()
    const nodes = []
    const root = document.body || document.documentElement
    if (!root) return nodes
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (element) => {
        const tag = element.tagName
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      }
    })
    let element = root
    let scanned = 0
    while (element && nodes.length < maxNodes && scanned < maxNodes * 12) {
      scanned += 1
      if (isVisible(element) && element !== document.body) {
        const role = roleOf(element)
        const text = accessibleName(element)
        const interactive = INTERACTIVE.has(element.tagName) || clickable(element) !== null
        if (interactive || text !== '' || role === 'heading') {
          nodes.push({
            ref: refFor(element),
            role,
            name: text,
            tag: element.tagName.toLowerCase(),
            disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
            ...(element.tagName === 'INPUT' || element.tagName === 'TEXTAREA'
              ? { value: String(element.value ?? '').slice(0, 200), inputType: (element.getAttribute('type') || 'text').toLowerCase() }
              : {})
          })
        }
      }
      element = walker.nextNode()
    }
    return nodes
  }

  const centreOf = (element) => {
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    const rect = element.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  }
`

/**
 * Build the page-facing source. Kept as a template string so the plugin can
 * inject it with a single executeJavaScript call.
 */
export const AGENT_SOURCE = `
(() => {
  if (window.${AGENT_GLOBAL}) return { installed: true, reused: true }
  ${SNAPSHOT_HELPERS}

  const describe = (element) => ({
    ref: element ? refFor(element) : undefined,
    role: element ? roleOf(element) : undefined,
    name: element ? accessibleName(element) : '',
    tag: element ? element.tagName.toLowerCase() : undefined
  })

  const resolveTarget = (params) => {
    if (params && params.ref) {
      const byRef = elementFor(params.ref)
      if (!byRef) throw new Error('快照引用已失效：' + params.ref + '（请重新调用 browser_snapshot）')
      return byRef
    }
    if (params && typeof params.selector === 'string' && params.selector !== '') {
      const found = document.querySelector(params.selector)
      if (!found) throw new Error('找不到元素：' + params.selector)
      return found
    }
    if (params && Number.isFinite(params.x) && Number.isFinite(params.y)) {
      const hit = document.elementFromPoint(params.x, params.y)
      if (!hit) throw new Error('该坐标没有元素：' + params.x + ',' + params.y)
      return hit
    }
    return undefined
  }

  const dispatchMouse = (element, type, point) => {
    const target = element || document.elementFromPoint(point.x, point.y) || document.body
    target.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: point.x, clientY: point.y, button: 0, buttons: type === 'mousedown' ? 1 : 0
    }))
    return target
  }

  /**
   * Dispatch one pointer event.
   *
   * Modern frameworks bind pointerdown / pointerup rather than the mouse
   * equivalents (React 18 pointer events, Vue's @pointerdown, most drag
   * libraries). A click built from mouse events alone silently does nothing on
   * those pages, so both families are sent in the order a real device produces.
   */
  const dispatchPointer = (element, type, point) => {
    const target = element || document.elementFromPoint(point.x, point.y) || document.body
    const init = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: point.x, clientY: point.y,
      button: type === 'pointermove' ? -1 : 0,
      buttons: type === 'pointerdown' ? 1 : 0,
      pointerId: 1, pointerType: 'mouse', isPrimary: true,
    }
    let event
    try {
      event = new PointerEvent(type, init)
    } catch {
      // Older engines without PointerEvent: a MouseEvent still fires listeners
      // registered for the pointer type by name.
      event = new MouseEvent(type, init)
    }
    target.dispatchEvent(event)
    return target
  }

  /**
   * Whether Shift/Ctrl/Meta/Alt is held for a synthetic key press.
   *
   * Only the modifiers that change what a key actually does are honoured;
   * anything else would need real OS state, which a page cannot fabricate.
   */
  const modifierOf = (key) => ({
    shiftKey: key.startsWith('Shift+'),
    ctrlKey: key.startsWith('Control+') || key.startsWith('Ctrl+'),
    altKey: key.startsWith('Alt+'),
    metaKey: key.startsWith('Meta+'),
  })

  /**
   * Strip a Shift+-style prefix off the key that follows it.
   *
   * The escaped plus is doubled on purpose: this file is a template string, so a
   * single backslash would collapse into a regex quantifier and match the wrong
   * characters, turning "Control+a" into "+a".
   */
  const baseKeyOf = (raw) => raw.replace(/^(?:Shift|Control|Ctrl|Alt|Meta)\\+/u, '')

  /**
   * Whether an element is a contenteditable host.
   *
   * Contenteditable is detected through the attribute as well as the property:
   * every browser implements the isContentEditable property for real elements,
   * but some DOM implementations (jsdom among them) do not, and the attribute is
   * the ground truth either way.
   */
  const isContentEditableHost = (element) => {
    if (!element || element.nodeType !== 1) return false
    if (element.isContentEditable === true) return true
    const attribute = element.getAttribute && element.getAttribute('contenteditable')
    if (attribute === null || attribute === undefined) return false
    const value = String(attribute).toLowerCase()
    return value === '' || value === 'true' || value === 'plaintext-only'
  }

  /** Whether an element accepts typed characters. */
  const isEditable = (element) => {
    if (!element || element.nodeType !== 1) return false
    if (isContentEditableHost(element)) return true
    if (element.tagName === 'TEXTAREA') return element.readOnly !== true && element.disabled !== true
    if (element.tagName === 'INPUT') {
      const type = (element.getAttribute('type') || 'text').toLowerCase()
      const textual = ['text', 'search', 'url', 'tel', 'email', 'password', 'number']
      return textual.includes(type) && element.readOnly !== true && element.disabled !== true
    }
    return false
  }

  /** Write a value the way typing does, through the prototype setter. */
  const writeValue = (element, next) => {
    if (isContentEditableHost(element)) {
      element.textContent = next
      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
      return next
    }
    const proto = element.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(element, next)
    else element.value = next
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    return next
  }

  /**
   * Apply the effect of an editing key.
   *
   * Returns the new value when the key changed something, or null when it is not
   * an editing key (arrow keys, Escape, Tab and similar are left to the page).
   */
  const applyEditKey = (element, key, modifiers) => {
    if (!isEditable(element)) return null
    const isContent = isContentEditableHost(element)
    const current = isContent ? String(element.textContent ?? '') : String(element.value ?? '')
    // A page cannot report a caret position reliably, so edits apply at the end,
    // which is where typing leaves it for the usual "type then press Backspace".
    if (key === 'Backspace') return writeValue(element, current.slice(0, -1))
    if (key === 'Delete') return writeValue(element, current)
    if (key === 'Enter') {
      // Enter in a textarea inserts a newline; the form-submit path above covers
      // the single-line case.
      if (element.tagName === 'TEXTAREA' || isContent) return writeValue(element, current + '\\n')
      return null
    }
    if (key.length === 1 && (modifiers.ctrlKey || modifiers.metaKey) && (key === 'a' || key === 'A')) {
      return writeValue(element, '')
    }
    if (key.length === 1 && !modifiers.ctrlKey && !modifiers.metaKey) {
      return writeValue(element, current + key)
    }
    return null
  }

  window.${AGENT_GLOBAL} = {
    version: 1,

    /** Page identity plus viewport geometry. */
    state() {
      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: Math.round(window.scrollX),
          scrollY: Math.round(window.scrollY),
          scrollWidth: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
          scrollHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)
        }
      }
    },

    /** Accessibility-style node list with stable refs. */
    snapshot(params) {
      const maxNodes = Math.min(Math.max(Number(params && params.maxNodes) || 400, 1), 2000)
      return { ...this.state(), nodes: buildSnapshot(maxNodes) }
    },

    /** Visible text, optionally scoped to a selector. */
    readText(params) {
      const scope = params && params.selector ? document.querySelector(params.selector) : document.body
      if (!scope) throw new Error('找不到元素：' + params.selector)
      const text = (scope.innerText || scope.textContent || '').replace(/\\n{3,}/g, '\\n\\n').trim()
      const limit = Math.min(Math.max(Number(params && params.maxChars) || 12000, 1), 200000)
      return { text: text.slice(0, limit), truncated: text.length > limit, length: text.length }
    },

    /** Evaluate an expression in the page and return a JSON-safe value. */
    evaluate(params) {
      const expression = String(params && params.expression ? params.expression : '')
      if (expression === '') throw new Error('expression 不能为空')
      // eslint-disable-next-line no-new-func
      const value = new Function('return (' + expression + ')')()
      if (value === undefined) return null
      if (value === null || typeof value !== 'object') return value
      try { return JSON.parse(JSON.stringify(value)) } catch { return String(value) }
    },

    /** Scroll by a delta, or to an element. */
    scroll(params) {
      const target = params && (params.ref || params.selector) ? resolveTarget(params) : undefined
      if (target !== undefined) {
        target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      } else {
        window.scrollBy(Number(params && params.dx) || 0, Number(params && params.dy) || 0)
      }
      return this.state()
    },

    /** Click by ref, selector or viewport coordinate. */
    click(params) {
      const element = resolveTarget(params)
      if (!element) throw new Error('缺少点击目标：请提供 ref、selector 或 x/y')
      if (element.disabled === true) throw new Error('元素已禁用：' + (element.tagName || ''))
      const point = params && Number.isFinite(params.x) && Number.isFinite(params.y)
        ? { x: params.x, y: params.y }
        : centreOf(element)
      element.focus({ preventScroll: true })
      // A real press produces pointer events around the mouse events; pages built
      // on pointer listeners (most modern frameworks) ignore mouse-only dispatch.
      dispatchPointer(element, 'pointerover', point)
      dispatchPointer(element, 'pointerenter', point)
      dispatchPointer(element, 'pointerdown', point)
      dispatchMouse(element, 'mousedown', point)
      dispatchPointer(element, 'pointerup', point)
      dispatchMouse(element, 'mouseup', point)
      // HTMLElement.click() runs the activation behaviour a human click would:
      // following a link, submitting a form, toggling a checkbox. Dispatching a
      // bare MouseEvent does not, so a link "click" previously reported an href
      // without ever navigating.
      let activated = false
      if (typeof element.click === 'function') {
        element.click()
        activated = true
      }
      if (!activated) dispatchMouse(element, 'click', point)
      const link = element.closest && element.closest('a')
      return {
        clicked: describe(element),
        ...(link && link.href ? { href: link.href } : {}),
        ...this.state()
      }
    },

    /** Hover an element by ref, selector or coordinate. */
    hover(params) {
      const element = resolveTarget(params)
      if (!element) throw new Error('缺少悬停目标：请提供 ref、selector 或 x/y')
      const point = params && Number.isFinite(params.x) && Number.isFinite(params.y)
        ? { x: params.x, y: params.y }
        : centreOf(element)
      dispatchPointer(element, 'pointerover', point)
      dispatchPointer(element, 'pointerenter', point)
      dispatchPointer(element, 'pointermove', point)
      dispatchMouse(element, 'mouseover', point)
      dispatchMouse(element, 'mouseenter', point)
      dispatchMouse(element, 'mousemove', point)
      return { hovered: point }
    },

    /** Type into a field, replacing its current value. */
    type(params) {
      const element = resolveTarget(params)
      if (!element) throw new Error('缺少输入目标：请提供 ref、selector 或 x/y')
      const text = String(params && params.text !== undefined ? params.text : '')
      const clear = !params || params.clear !== false
      const editable = isContentEditableHost(element)
      if (!editable && !('value' in element)) {
        throw new Error(
          '该元素不能输入文本：' + element.tagName + '（只支持 input / textarea / contenteditable）',
        )
      }

      element.focus({ preventScroll: true })
      if (editable) {
        // Rich editors keep their state in the DOM, so write text nodes and let
        // the framework observe a normal input event.
        element.textContent = clear ? text : String(element.textContent ?? '') + text
      } else {
        const proto = element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        setter.call(element, clear ? text : String(element.value ?? '') + text)
      }
      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
      element.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
      return {
        typed: text.length,
        value: String(element.value !== undefined ? element.value : element.textContent ?? '').slice(0, 200),
        target: describe(element)
      }
    },

    /**
     * Send a key to the focused element (or a specific target).
     *
     * A page cannot synthesise OS-level key events, so the visible effect has to
     * be produced here as well as reported: dispatching keydown alone never
     * deletes a character, which made Backspace/Delete appear to do nothing in
     * any input the page did not handle itself. Editing keys therefore apply
     * their effect and fire input, the same shape a real key produces.
     *
     * Modifiers may be written the way a user would: Shift+Tab, Control+a.
     */
    press(params) {
      const raw = String(params && params.key ? params.key : '')
      if (raw === '') throw new Error('key 不能为空')
      const key = baseKeyOf(raw)
      const modifiers = modifierOf(raw)
      const element = (params && (params.ref || params.selector)) ? resolveTarget(params) : document.activeElement
      const target = element || document.body
      if (target && target.focus) target.focus({ preventScroll: true })
      const init = { key, bubbles: true, cancelable: true, composed: true, ...modifiers }
      target.dispatchEvent(new KeyboardEvent('keydown', init))
      target.dispatchEvent(new KeyboardEvent('keypress', init))

      // Apply the effect the key would have had on an editable element.
      let edited = null
      if (isEditable(target)) edited = applyEditKey(target, key, modifiers)

      target.dispatchEvent(new KeyboardEvent('keyup', init))
      // Enter on a focused form control should submit, as a real key press would.
      if (key === 'Enter' && !modifiers.shiftKey) {
        const form = target.closest && target.closest('form')
        if (form) {
          if (typeof form.requestSubmit === 'function') form.requestSubmit()
          else form.submit()
        }
      }
      return {
        pressed: raw,
        target: describe(target),
        ...(edited === null ? {} : { edited }),
      }
    },

    /** Choose an option in a <select>. */
    select(params) {
      const element = resolveTarget(params)
      if (!element) throw new Error('缺少下拉目标：请提供 ref 或 selector')
      if (element.tagName !== 'SELECT') throw new Error('目标不是 SELECT：' + element.tagName)
      const wanted = String(params && params.value !== undefined ? params.value : params && params.label ? params.label : '')
      let matched = false
      for (const option of element.options) {
        const hit = option.value === wanted || (option.text || '').trim() === wanted
        if (hit) { element.value = option.value; matched = true; break }
      }
      if (!matched) throw new Error('没有匹配的选项：' + wanted)
      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
      element.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
      return { value: element.value, label: element.options[element.selectedIndex]?.text ?? '' }
    },

    /** Wait until a selector appears or the text shows up. */
    async wait(params) {
      const selector = params && typeof params.selector === 'string' ? params.selector : ''
      const text = params && typeof params.text === 'string' ? params.text : ''
      const timeoutMs = Math.min(Math.max(Number(params && params.timeoutMs) || 10000, 50), 120000)
      const started = Date.now()
      const check = () => {
        if (selector !== '') {
          const found = document.querySelector(selector)
          if (!found) return false
          if (params && params.state === 'visible' && !isVisible(found)) return false
          return true
        }
        // innerText is not available in every DOM implementation, so fall back to
        // textContent: a wait for text must never crash the whole tool.
        if (text !== '') {
          const body = document.body
          const content = body ? (body.innerText || body.textContent || '') : ''
          return String(content).includes(text)
        }
        return true
      }
      while (Date.now() - started < timeoutMs) {
        if (check()) return { matched: true, waitedMs: Date.now() - started, ...this.state() }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return { matched: false, waitedMs: Date.now() - started, ...this.state() }
    },

    /**
     * Attach files to a file input.
     *
     * The panel cannot open a native picker on the agent's behalf, so the host
     * reads the bytes and passes them here as base64. Each entry becomes a real
     * File object in the page, exactly as if the user had chosen it, so framework
     * upload widgets (which read input.files) work unchanged.
     *
     * @param {{ref?: string, selector?: string, files?: Array<{name: string, type?: string, base64: string}>}} params
     */
    files(params) {
      const element = resolveTarget(params)
      if (!element) throw new Error('缺少文件输入框')
      if (element.tagName !== 'INPUT' || element.type !== 'file') {
        throw new Error('目标不是文件输入框：' + element.tagName + (element.type ? '/' + element.type : ''))
      }
      const entries = Array.isArray(params && params.files) ? params.files : []
      if (entries.length === 0) throw new Error('没有要上传的文件')

      const transfer = new DataTransfer()
      const attached = []
      for (const entry of entries) {
        const binary = atob(String(entry.base64 ?? ''))
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
        const file = new File([bytes], String(entry.name ?? 'file'), {
          type: String(entry.type ?? 'application/octet-stream'),
        })
        transfer.items.add(file)
        attached.push({ name: file.name, size: file.size, type: file.type })
      }

      element.files = transfer.files
      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
      element.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
      return { attached: transfer.files.length, files: attached }
    },

    /**
     * Render an element (or the viewport) to a PNG data URL.
     *
     * The plugin cannot screenshot the native guest, but whatever draws inside
     * the page can hand its own pixels back. Charts are the reason this exists:
     * they are <canvas> or <svg>, and both can be rasterised here.
     *
     * @param {{ref?: string, selector?: string, fullPage?: boolean, scale?: number}} params
     */
    async capture(params) {
      const scale = Math.min(Math.max(Number(params && params.scale) || 2, 1), 3)

      /** Serialise an <svg> element, inlining the page's CSS so it renders. */
      const svgToPng = async (svg) => {
        const rect = svg.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) throw new Error('该图表尺寸为 0，可能还没渲染完成')
        const clone = svg.cloneNode(true)
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
        clone.setAttribute('width', Math.round(rect.width))
        clone.setAttribute('height', Math.round(rect.height))
        // Inline every readable stylesheet: a detached SVG has no cascade.
        let css = ''
        for (const sheet of Array.from(document.styleSheets)) {
          try {
            for (const rule of Array.from(sheet.cssRules)) css += rule.cssText + '\\n'
          } catch {
            /* cross-origin sheet: skip */
          }
        }
        const style = document.createElementNS('http://www.w3.org/2000/svg', 'style')
        style.textContent = css
        clone.insertBefore(style, clone.firstChild)
        const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
        background.setAttribute('width', '100%')
        background.setAttribute('height', '100%')
        background.setAttribute('fill', '#ffffff')
        clone.insertBefore(background, style.nextSibling)

        const markup = new XMLSerializer().serializeToString(clone)
        const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup)
        const image = new Image()
        await new Promise((resolve, reject) => {
          image.onload = () => resolve()
          image.onerror = () => reject(new Error('SVG 转图片失败'))
          image.src = url
        })
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(rect.width * scale)
        canvas.height = Math.round(rect.height * scale)
        const context = canvas.getContext('2d')
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, canvas.width, canvas.height)
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height }
      }

      /** Copy a <canvas> as it stands. */
      const canvasToPng = (canvas) => {
        const out = document.createElement('canvas')
        out.width = Math.round(canvas.width * scale)
        out.height = Math.round(canvas.height * scale)
        const context = out.getContext('2d')
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, out.width, out.height)
        context.drawImage(canvas, 0, 0, out.width, out.height)
        return { dataUrl: out.toDataURL('image/png'), width: out.width, height: out.height }
      }

      // 1. An explicit target: honour whatever kind of element it is.
      const target = params && (params.ref || params.selector) ? resolveTarget(params) : undefined
      if (target !== undefined) {
        const tag = target.tagName.toLowerCase()
        if (tag === 'canvas') {
          return { ...canvasToPng(target), tag: 'canvas', ...this.state() }
        }
        if (tag === 'svg') {
          return { ...(await svgToPng(target)), tag: 'svg', ...this.state() }
        }
        // A container: prefer a chart inside it, else the largest canvas/svg.
        const inner = target.querySelector('canvas, svg')
        if (inner !== null) {
          const innerTag = inner.tagName.toLowerCase()
          if (innerTag === 'canvas') return { ...canvasToPng(inner), tag: 'canvas', ...this.state() }
          return { ...(await svgToPng(inner)), tag: 'svg', ...this.state() }
        }
        throw new Error('目标元素里没有 canvas 或 svg，无法导出图像')
      }

      // 2. No target: take the biggest chart on the page (charts dominate area).
      const charts = [
        ...Array.from(document.querySelectorAll('canvas')),
        ...Array.from(document.querySelectorAll('svg')),
      ]
        .map((element) => {
          const rect = element.getBoundingClientRect()
          return { element, area: rect.width * rect.height, rect }
        })
        .filter((entry) => entry.area > 12000)
        .sort((left, right) => right.area - left.area)

      if (charts.length === 0) {
        throw new Error('页面上没有可导出的图表（canvas/svg）。请用 browser_snapshot 或 browser_read_text 获取内容。')
      }
      const biggest = charts[0]
      const tag = biggest.element.tagName.toLowerCase()
      const rendered = tag === 'canvas'
        ? canvasToPng(biggest.element)
        : await svgToPng(biggest.element)
      return {
        ...rendered,
        tag,
        count: charts.length,
        ...this.state(),
      }
    }
  }

  return { installed: true, reused: false }
})()
`
