/**
 * Model-facing browser tools.
 *
 * Every tool drives the page visible in the DSH right sidebar: the call is
 * queued on the bridge, the panel picks it up, runs it on the live <webview>
 * guest, and posts the result back. Nothing is captured or streamed — the agent
 * and the human operate the same page.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { jsonOutput } from './output.js'
import { resolveConfig, defaultImageDir } from './config.js'

export { jsonOutput }

/**
 * Which browser tab to act on.
 *
 * The sidebar keeps its tab ids internal, so this cannot be honoured: the plugin
 * acts on the focused guest, else the newest one. The parameter used to be
 * declared anyway and then silently dropped, which let a caller believe it had
 * aimed at a specific tab. It is gone rather than misleading.
 */

const SENSITIVE_PARAM = {
  sensitive: {
    type: 'boolean',
    description:
      '本次操作是否会提交订单/付款/删除/发送消息/修改账号等不可撤销的敏感动作。设为 true 时插件会先向用户确认，用户拒绝则不执行。',
  },
}

/**
 * Turn what a model or human typed into a navigable URL.
 *
 * Kept in the host so the same rule decides both the address handed to the
 * sidebar when it opens a new tab and the one fed to the page afterwards.
 *
 * @param {unknown} raw
 * @returns {string | undefined}
 */
export function normalizeAddress(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return undefined
  // localhost / bare IP must be tested before the scheme test: "localhost:5173"
  // looks like a scheme to the generic pattern, and would become a bogus URL.
  if (/^localhost(:\d+)?(\/|$)/i.test(text)) return `http://${text}`
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(text)) return `http://${text}`
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text
  return `https://${text}`
}

/**
 * Ask the human to confirm one sensitive action. Resolves allowed only on an
 * explicit grant; a missing question channel denies (fail-closed).
 */
async function confirmAction(ctx, exec, { action, detail }) {
  const questions = ctx.get('userQuestions')
  if (questions === undefined || exec.agent === undefined) {
    return { allowed: false, reason: '没有可用的用户确认通道，已拒绝该敏感操作' }
  }
  try {
    const result = await questions.ask({
      questions: [
        {
          id: 'confirm',
          header: '敏感操作确认',
          question: `即将执行：${action}\n\n${detail}\n\n是否允许这一次操作？`,
          options: [
            { label: '允许本次操作', description: '只放行这一次，不会记住。' },
            { label: '拒绝', description: '不执行，把决定告诉模型。' },
          ],
        },
      ],
      agent: exec.agent,
      wait: { callId: exec.callId },
      signal: exec.signal,
    })
    const answer = result?.answers?.[0]
    const granted =
      answer?.selected?.includes('允许本次操作') === true ||
      (answer?.custom ?? '').trim() === '允许本次操作'
    return { allowed: granted, reason: granted ? '用户已允许本次操作' : '用户拒绝了该操作' }
  } catch (error) {
    return { allowed: false, reason: `确认过程失败，已拒绝：${String(error?.message ?? error)}` }
  }
}

/**
 * Register every browser tool.
 *
 * @param {object} ctx plugin context
 * @param {object} cfg resolved config (see lib/config.js)
 * @param {import('./bridge.js').BrowserBridge} bridge
 * @param {object} panelControl host helpers: imageDir, readUpload, downloads, openTab
 */
export function registerBrowserTools(ctx, rawConfig, bridge, panelControl = {}) {
  const cfg = resolveConfig(rawConfig)
  const register = (definition) => ctx.tools.register({ ...definition, output: jsonOutput() })
  const imageDir = panelControl.imageDir ?? cfg.imageDir

  /**
   * The conversation a tool call came from.
   *
   * DSH keeps one sidebar per Session. Binding every command to its Session is
   * what stops a browser from opening in a different chat just because the user
   * switched conversations while the request was in flight.
   *
   * @param {object} [exec] tool execution context
   * @returns {string | undefined}
   */
  const sessionOf = (exec) => {
    const id = exec?.agent?.session?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  }

  /** Run one command on the panel, surfacing its failures as tool errors. */
  const run = async (method, params, options, exec) => {
    try {
      return await bridge.call(method, params, {
        ...options,
        // Never let a caller override the binding: the conversation is a fact
        // about the call, not a preference.
        sessionId: sessionOf(exec),
      })
    } catch (error) {
      throw new Error(String(error?.message ?? error))
    }
  }

  /**
   * Ask before an irreversible action, but only while the setting is on.
   *
   * `confirmSensitive` used to be declared and never read: turning it off
   * changed nothing. Now it is the switch that decides whether a `sensitive`
   * argument produces a question at all.
   */
  const guard = async (exec, args, action, detail) => {
    if (cfg.confirmSensitive !== true || args.sensitive !== true) return undefined
    const decision = await confirmAction(ctx, exec, { action, detail })
    return decision.allowed ? undefined : { executed: false, reason: decision.reason }
  }

  register({
    name: 'browser_status',
    description:
      '查看内嵌浏览器状态：右侧栏的浏览器面板是否打开、页面是否可操作。开始网页任务前先调用它确认环境。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(args, exec) {
      const attached = bridge.attached
      // `page` must stay JSON-clean: returning `undefined` makes DSH reject the
      // whole tool result as "not lossless JSON", which users see as a crash.
      let page = null
      let pageError
      if (attached) {
        // A status check must never hang: it is the tool a caller reaches for
        // precisely when something is wrong. Keep its probe short so a busy or
        // stuck page reports quickly instead of burning the full command timeout.
        try {
          page = await run('state', {}, { panelWaitMs: 0, timeoutMs: 3000 }, exec)
        } catch (error) {
          pageError = String(error?.message ?? error)
        }
      }
      return {
        attached,
        page,
        ...(pageError === undefined ? {} : { pageError }),
        hint: attached
          ? '浏览器面板已就绪，直接用 browser_navigate / browser_snapshot 操作页面。'
          : '浏览器面板未打开。可以调用 browser_open_panel 自动打开，或请用户点 DSH 右侧栏的「浏览器」标签页。',
      }
    },
  })

  register({
    name: 'browser_open_panel',
    description:
      '在 DSH 右侧栏打开「浏览器」标签页。面板已经打开时不做任何事。agent 需要在用户没打开浏览器时自行打开时调用。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '可选：打开面板后直接加载这个地址。' },
      },
      additionalProperties: false,
    },
    async execute(args, exec) {
      // `attached` only says a client is polling, not that the sidebar actually
      // has a browser tab. With no tab open, the caller needs the tab created —
      // answering "already open" left them with nothing to drive.
      if (bridge.attached) {
        let hasPage = false
        try {
          const tabs = await run('tabs', {}, { panelWaitMs: 0, timeoutMs: 3000 }, exec)
          hasPage = Array.isArray(tabs?.tabs) && tabs.tabs.length > 0
        } catch {
          // Cannot tell, so fall through and try to open one.
          hasPage = false
        }
        if (hasPage) return { opened: false, reason: '面板已经打开' }
      }
      if (typeof panelControl?.openTab !== 'function') {
        throw new Error(
          '当前环境无法自动打开侧边栏：请用户点 DSH 右侧栏的「浏览器」标签页，然后重试',
        )
      }
      await panelControl.openTab(args.url)
      // The new tab needs a moment to mount and make its first poll.
      const deadline = Date.now() + cfg.openPanelWaitMs
      while (Date.now() < deadline && !bridge.attached) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return {
        opened: true,
        attached: bridge.attached,
        ...(bridge.attached
          ? {}
          : { hint: '侧边栏标签页已创建，但面板还没连上；请确认右侧栏可见后重试。' }),
      }
    },
  })

  register({
    name: 'browser_navigate',
    description:
      '在内嵌浏览器里打开一个网址。会在右侧栏的浏览器标签页里加载该页面，用户也能看到。主机名不带协议时按 https 处理。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的地址，例如 https://example.com 或 example.com' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      const url = normalizeAddress(args.url)
      if (url === undefined) throw new Error('url 不能为空')
      // Pass the address to the opener so a cold start opens the requested page
      // directly instead of an empty tab that then needs a second navigation.
      return run('navigate', { url }, { openUrl: url }, exec)
    },
  })

  register({
    name: 'browser_back',
    description: '在浏览器历史中后退一页。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(args, exec) {
      return run('back', {}, undefined, exec)
    },
  })

  register({
    name: 'browser_forward',
    description: '在浏览器历史中前进一页。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(args, exec) {
      return run('forward', {}, undefined, exec)
    },
  })

  register({
    name: 'browser_reload',
    description: '刷新当前页面。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(args, exec) {
      return run('reload', {}, undefined, exec)
    },
  })

  register({
    name: 'browser_snapshot',
    description:
      '读取当前页面的无障碍快照：每个可交互元素（链接、按钮、输入框、下拉框）都有稳定的 ref，后续 browser_click / browser_type 用 ref 定位。这是理解页面结构的主要方式。',
    parameters: {
      type: 'object',
      properties: {
        maxNodes: { type: 'number', description: `最多返回多少个节点，默认 ${cfg.maxSnapshotNodes}。` },
      },
      additionalProperties: false,
    },
    async execute(args, exec) {
      return run('snapshot', { maxNodes: args.maxNodes ?? cfg.maxSnapshotNodes }, undefined, exec)
    },
  })

  register({
    name: 'browser_read_text',
    description: '读取页面的可见文本（正文）。比快照更适合阅读文章、表格、列表等内容。',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器；省略时读取整个页面正文。' },
        maxChars: { type: 'number', description: `最多返回多少字符，默认 ${cfg.maxTextChars}。` },
      },
      additionalProperties: false,
    },
    async execute(args, exec) {
      return run('readText', { selector: args.selector, maxChars: args.maxChars ?? cfg.maxTextChars }, undefined, exec)
    },
  })

  register({
    name: 'browser_eval',
    description:
      '在页面里执行一段 JavaScript 表达式并返回结果。用于快照覆盖不到的场景，例如读取页面里的复杂数据结构。表达式在页面上下文运行，可以访问 document、window。',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '要执行的 JavaScript 表达式，例如 document.title' },
      },
      required: ['expression'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      // Arbitrary code in whatever page is loaded is the one capability an
      // operator may reasonably want off; the setting exists for that.
      if (cfg.allowEval !== true) {
        return {
          executed: false,
          reason: 'browser_eval 已在插件设置中禁用（allowEval）',
          hint: '需要读取结构化数据时改用 browser_snapshot 或 browser_read_text。',
        }
      }
      return run('evaluate', { expression: String(args.expression) }, undefined, exec)
    },
  })

  register({
    name: 'browser_click',
    description:
      '点击页面元素。用 ref（来自 browser_snapshot）或 selector 指定目标，也可以用 x/y 视口坐标。点击真实发生在页面上，用户能在面板里看到。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '元素引用，来自 browser_snapshot 的 ref 字段。' },
        selector: { type: 'string', description: 'CSS 选择器，ref 不可用时使用。' },
        x: { type: 'number', description: '视口 X 坐标（配合 y）。' },
        y: { type: 'number', description: '视口 Y 坐标（配合 x）。' },
        ...SENSITIVE_PARAM,
      },
      additionalProperties: false,
    },
    async execute(args, exec) {
      const refused = await guard(
        exec,
        args,
        '点击页面元素',
        `目标：${args.ref ?? args.selector ?? `${args.x},${args.y}`}`,
      )
      if (refused !== undefined) return refused
      return run('click', { ref: args.ref, selector: args.selector, x: args.x, y: args.y }, undefined, exec)
    },
  })

  register({
    name: 'browser_type',
    description:
      '在输入框里输入文本（默认先清空原有内容）。用 ref 或 selector 指定输入框。会真实输入到页面并触发页面自己的 input/change 事件。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '输入框引用，来自 browser_snapshot。' },
        selector: { type: 'string', description: 'CSS 选择器。' },
        text: { type: 'string', description: '要输入的文本。' },
        clear: { type: 'boolean', description: '是否先清空原有内容，默认 true。' },
        ...SENSITIVE_PARAM,
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      const refused = await guard(
        exec,
        args,
        '在页面输入文本',
        `目标：${args.ref ?? args.selector}\n内容：${String(args.text).slice(0, 200)}`,
      )
      if (refused !== undefined) return refused
      return run('type', {
        ref: args.ref,
        selector: args.selector,
        text: args.text,
        clear: args.clear,
      }, undefined, exec)
    },
  })

  register({
    name: 'browser_press',
    description: '按下键盘按键（例如 Enter、Tab、Escape、ArrowDown）。Enter 在表单里会触发表单提交。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '按键名，例如 Enter / Tab / Escape / ArrowDown。' },
        ref: { type: 'string', description: '可选：把按键发给指定元素，省略时发给当前焦点元素。' },
        selector: { type: 'string', description: '可选：用 CSS 选择器指定接收按键的元素。' },
        x: { type: 'number', description: '可选：按视口坐标定位接收按键的元素。' },
        y: { type: 'number', description: '可选：按视口坐标定位接收按键的元素。' },
        ...SENSITIVE_PARAM,
      },
      required: ['key'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      const refused = await guard(exec, args, '按键', `按键：${args.key}`)
      if (refused !== undefined) return refused
      // selector 和坐标必须继续往下传：注入脚本会据此找到目标元素，
      // 否则按键只会落在 body 上，编辑键对输入框完全无效。
      return run(
        'press',
        { key: args.key, ref: args.ref, selector: args.selector, x: args.x, y: args.y },
        undefined,
        exec,
      )
    },
  })

  register({
    name: 'browser_select',
    description: '在下拉框（select）里选择一个选项，按 value 或显示文本匹配。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '下拉框引用，来自 browser_snapshot。' },
        selector: { type: 'string', description: 'CSS 选择器。' },
        value: { type: 'string', description: '选项的 value。' },
        label: { type: 'string', description: '选项的显示文本（value 不可用时使用）。' },
      },
      additionalProperties: false,
    },
    async execute(args, exec) {
      return run('select', {
        ref: args.ref,
        selector: args.selector,
        value: args.value,
        label: args.label,
      }, undefined, exec)
    },
  })

  register({
    name: 'browser_hover',
    description: '把鼠标移到元素上，用于触发悬停菜单或提示。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '元素引用。' },
        selector: { type: 'string', description: 'CSS 选择器。' },
        x: { type: 'number', description: '视口 X 坐标。' },
        y: { type: 'number', description: '视口 Y 坐标。' },
      },
      additionalProperties: false,
    },
    async execute(args, exec) {
      return run('hover', { ref: args.ref, selector: args.selector, x: args.x, y: args.y }, undefined, exec)
    },
  })

  register({
    name: 'browser_scroll',
    description: '滚动页面。可以按像素滚动，也可以滚到某个元素。滚动会真实发生在面板里。',
    parameters: {
      type: 'object',
      properties: {
        dy: { type: 'number', description: '垂直滚动像素，正数向下，默认 600。' },
        dx: { type: 'number', description: '水平滚动像素。' },
        ref: { type: 'string', description: '可选：滚到这个元素。' },
      },
      additionalProperties: false,
    },
    async execute(args, exec) {
      return run('scroll', {
        dy: args.dy === undefined ? 600 : args.dy,
        dx: args.dx,
        ref: args.ref,
      }, undefined, exec)
    },
  })

  register({
    name: 'browser_wait',
    description:
      '等待页面出现某个选择器或某段文本，用于等待导航、加载、异步渲染完成。超时返回 matched:false，不抛错。',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '等待这个选择器出现。' },
        text: { type: 'string', description: '等待页面包含这段文本。' },
        state: {
          type: 'string',
          enum: ['visible', 'attached'],
          description: '选择器的状态要求，默认 attached。',
        },
        timeoutMs: { type: 'number', description: `超时毫秒，默认 ${cfg.waitTimeoutMs}。` },
      },
      additionalProperties: false,
    },
    async execute(args, exec) {
      return run('wait', {
        selector: args.selector,
        text: args.text,
        state: args.state,
        timeoutMs: args.timeoutMs ?? cfg.waitTimeoutMs,
      }, undefined, exec)
    },
  })

  register({
    name: 'browser_screenshot',
    description:
      '把页面上的图表或指定元素导出成 PNG 图片文件，返回本地路径。内嵌浏览器渲染在原生层，无法截取整个窗口的像素，但页面自己画出来的 canvas / svg（走势图、K线图、涨跌分布图等）可以在这里栅格化成图片。不传 ref/selector 时自动选页面上面积最大的图表。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '要导出图像的元素 ref（来自 browser_snapshot），可以是 canvas、svg 或包含它们的容器。' },
        selector: { type: 'string', description: '要导出图像的元素 CSS 选择器。' },
        scale: { type: 'number', description: '导出倍率，默认 2（更清晰），范围 1-3。' },
      },
      additionalProperties: false,
    },
    async execute(args, exec) {
      const captured = await run('capture', {
        ref: args.ref,
        selector: args.selector,
        scale: args.scale,
      }, undefined, exec)
      const dataUrl = String(captured?.dataUrl ?? '')
      if (!dataUrl.startsWith('data:image/png;base64,')) {
        throw new Error('页面没有返回可用的图片数据')
      }
      const bytes = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64')
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
      const slug = String(captured.title ?? 'page')
        .replace(/[\\/:*?"<>|\s]+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 60) || 'page'
      const dir = String(imageDir ?? '').trim() === '' ? defaultImageDir() : imageDir
      mkdirSync(dir, { recursive: true })
      const path = join(dir, `${slug}-${captured.tag ?? 'chart'}-${stamp}.png`)
      writeFileSync(path, bytes)
      return {
        path,
        bytes: bytes.length,
        width: captured.width,
        height: captured.height,
        element: captured.tag,
        url: captured.url,
        title: captured.title,
        ...(captured.count === undefined ? {} : { chartsOnPage: captured.count }),
      }
    },
  })

  register({
    name: 'browser_tabs',
    description: '列出右侧栏里打开的所有浏览器标签页。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(args, exec) {
      return run('tabs', {}, undefined, exec)
    },
  })

  register({
    name: 'browser_tab_new',
    description: '在右侧栏新建一个浏览器标签页，可选地直接打开一个地址。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的地址；省略时打开空白页。' },
        activate: { type: 'boolean', description: '是否切换到这个新标签页，默认 true。' },
      },
      additionalProperties: false,
    },
    async execute(args, exec) {
      return run('tabNew', { url: args.url, activate: args.activate !== false }, undefined, exec)
    },
  })

  register({
    name: 'browser_tab_close',
    description:
      '关闭一个浏览器标签页。侧边栏的标签页由 DSH 自己管理，插件无法关闭；请让用户点标签上的 × 。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return {
        executed: false,
        reason: 'DSH 未向插件开放关闭侧边栏标签页的接口',
        hint: '请让用户点右侧栏标签上的 × 关闭',
      }
    },
  })

  register({
    name: 'browser_tab_activate',
    description:
      '切换到一个浏览器标签页。侧边栏的标签切换由 DSH 自己管理，插件无法直接切；请让用户点标签本身。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return {
        executed: false,
        reason: 'DSH 未向插件开放切换侧边栏标签页的接口',
        hint: '请让用户直接点右侧栏的标签',
      }
    },
  })

  register({
    name: 'browser_upload',
    description:
      '给页面里的文件输入框（input type=file）设置本地文件。传入本地绝对路径；网页会像用户手动选择一样收到这些文件。',
    parameters: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: '本地文件的绝对路径列表。' },
        ref: { type: 'string', description: '文件输入框的 ref。' },
        selector: { type: 'string', description: '文件输入框的 CSS 选择器。' },
      },
      required: ['files'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      if (!Array.isArray(args.files) || args.files.length === 0) {
        throw new Error('files 不能为空：请传本地绝对路径')
      }
      // The page cannot read the filesystem, and a native picker cannot be
      // driven, so the host reads each file and passes the bytes through.
      const prepared = []
      for (const path of args.files) {
        const file = await panelControl.readUpload(String(path))
        prepared.push({ name: file.name, type: file.type, base64: file.base64 })
      }
      return run('files', {
        files: prepared,
        ref: args.ref,
        selector: args.selector,
      }, undefined, exec)
    },
  })

  register({
    name: 'browser_downloads',
    description:
      '列出浏览器下载目录里的文件（含本地路径、大小、时间）。内嵌浏览器沿用 Electron 默认行为，下载文件保存在系统「下载」文件夹。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多返回多少个文件，默认 20。' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      // Downloads are a host concern: the files are on disk, not in the page.
      return panelControl.downloads?.({ limit: args.limit ?? 20 })
    },
  })

  register({
    name: 'browser_confirm',
    description:
      '当页面弹出确认对话框、或某个动作不可撤销时，向用户请求一次明确的确认。用户拒绝时返回 allowed:false。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '一句话说明要确认的动作。' },
        detail: { type: 'string', description: '细节：目标页面、金额、收件人、影响范围等。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      const decision = await confirmAction(ctx, exec, {
        action: String(args.action),
        detail: String(args.detail ?? ''),
      })
      return { allowed: decision.allowed, reason: decision.reason }
    },
  })

  register({
    name: 'browser_reset_profile',
    description:
      '清空内嵌浏览器的浏览数据（Cookie、缓存、登录态）。DSH 未向插件开放浏览器会话的清理接口，因此本工具只给出操作指引，需要用户在 DSH 里手动清除。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return {
        executed: false,
        reason: 'DSH 未向插件开放清除浏览器会话的接口',
        howTo: [
          '关闭右侧栏的浏览器标签页（点标签上的 ×）',
          '如果是「清除登录状态」，在 DSH 的浏览器里退出对应站点，或重启 DSH 后在浏览器里重新登录',
          '需要彻底清理时：退出 DSH，删除 ~/.dsh/storages/dsh-live-browser（如存在）后重新打开',
        ],
      }
    },
  })
}

/** Tool names, used for startup logging and tests. */
export function browserToolNames() {
  return [
    'browser_status',
    'browser_open_panel',
    'browser_navigate',
    'browser_back',
    'browser_forward',
    'browser_reload',
    'browser_snapshot',
    'browser_read_text',
    'browser_eval',
    'browser_click',
    'browser_type',
    'browser_press',
    'browser_select',
    'browser_hover',
    'browser_scroll',
    'browser_wait',
    'browser_screenshot',
    'browser_tabs',
    'browser_tab_new',
    'browser_tab_close',
    'browser_tab_activate',
    'browser_upload',
    'browser_downloads',
    'browser_confirm',
    'browser_reset_profile',
  ]
}
