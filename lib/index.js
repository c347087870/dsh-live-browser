/**
 * dsh-live-browser — let the agent drive the browser DSH already ships.
 *
 * DSH's own `@deepseek-ai/dsh-client-ui-sidebar-browser` renders a real
 * Electron <webview> in the right sidebar, with an address bar, history and an
 * independent session. It exposes navigation only, so the agent can open a page
 * but cannot touch it.
 *
 * This plugin closes that gap without modifying DSH: the client half finds the
 * guests that plugin mounted (`webview[data-sidebar-browser-frame="webview"]`),
 * injects a command surface into each document, and polls this host half for
 * work. A tool call enqueues a command; the panel runs it on the live guest and
 * posts the result back, so the human and the agent operate the same page.
 */

import { BrowserBridge } from './bridge.js'
import { registerBrowserTools, browserToolNames } from './tools.js'
import { registerRpc, readUploadFile, listDownloads } from './rpc.js'
import { registerSkills } from './skills.js'
import { resolveConfig, defaultImageDir } from './config.js'
import { Config } from './schema.js'

export const name = 'dsh-live-browser'

/**
 * `webServer` is required because the panel talks to this half over an HTTP
 * endpoint mounted there. `connection.rpc.handle()` is unusable on this build
 * (see lib/rpc.js), so the route is registered directly.
 */
export const inject = ['tools', 'webServer']

export { Config }

export function apply(ctx, config) {
  const cfg = resolveConfig(config)

  /**
   * The sidebar service, when this DSH build exposes it.
   *
   * Read on every use, never captured: `openTab` is how the official browser tab
   * is created, and a service may register *after* this plugin loads. Snapshotting
   * it at apply time meant `browser_tab_new` failed forever on such a load order.
   */
  const sidebar = () => {
    try {
      return ctx.get('sidebarRight')
    } catch {
      return undefined
    }
  }

  /** Create the sidebar browser tab. Used for on-demand opens. */
  const openBrowserTab = async (url) => {
    const service = sidebar()
    if (service === undefined || typeof service.openTab !== 'function') {
      throw new Error('当前 DSH 版本没有提供打开侧边栏标签页的接口')
    }
    service.openTab('browser', url === undefined ? {} : { params: { url } })
    return { opened: true }
  }

  // Every tool funnels through the bridge. The panel half polls on its own and
  // creates the sidebar browser when it sees a queued command, so no host-side
  // opener is needed (the sidebar exists only in the renderer).
  const bridge = new BrowserBridge({ timeoutMs: cfg.commandTimeoutMs })

  /** Host-side helpers the tools call directly (no page round trip needed). */
  const host = {
    imageDir: cfg.imageDir,
    readUpload: async (path) => readUploadFile(path, { maxBytes: cfg.uploadMaxBytes }),
    downloads: async (options) =>
      listDownloads({ limit: options?.limit ?? 20, dir: cfg.downloadsDir }),
    openTab: openBrowserTab,
  }

  registerBrowserTools(ctx, cfg, bridge, host)
  // A getter, not a value: the sidebar service may mount after this plugin does.
  registerRpc(ctx, bridge, { sidebar, config: cfg })
  registerSkills(ctx)

  // Reject anything still queued when the plugin unloads, so callers fail fast
  // instead of waiting out their timeout.
  ctx.effect(() => () => {
    bridge.close()
  })

  ctx.logger.info(
    `[dsh-live-browser] loaded: ${browserToolNames().length} tools, driving the DSH sidebar browser`,
  )
}

export { defaultImageDir }
