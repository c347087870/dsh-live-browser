/**
 * The panel endpoint.
 *
 * A single prefix route on the DSH web server speaks the small
 * `{ type, rpcId, method, payload }` envelope that both halves share:
 *
 *   status   — is a panel polling
 *   source   — the agent script the panel injects into each guest document
 *   poll     — the panel asks for its next queued command
 *   settle   — the panel reports the outcome of a command it ran
 *
 * Why `webServer.register` instead of `connection.rpc.handle`: on this DSH build
 * that API builds its route with `owner.effect(() => owner.webServer.register(route))`
 * where `owner` is the connection plugin's own context, which never declared a
 * `webServer` dependency. The property read throws
 * `cannot get property "webServer" without inject`, the effect swallows it, and
 * every panel request then falls through to the static frontend fallback as
 * HTTP 405. Registering on `webServer` directly is the same call without the
 * broken indirection.
 *
 * ## Why every request is checked
 *
 * This route lives on DSH's own web server, so a page loaded in a browser can
 * reach it. `readUpload` alone would let a hostile page read a local file, and
 * `saveImage` would let it write one. Every request is therefore refused unless
 * it provably came from this server's own page: a browser always attaches
 * `Origin` (or `Sec-Fetch-Site`) to a cross-origin POST, so checking them blocks
 * the CSRF case while leaving the plugin's same-origin fetch untouched.
 *
 * A locally running process could still spoof those headers, but it can already
 * read and write the same files as this user, so it gains nothing here. Gating
 * on a token would not change that, and would only add a bootstrap endpoint that
 * hands the token out.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { AGENT_SOURCE } from './agent-script.js'
import { defaultDownloadsDir, defaultImageDir } from './config.js'

/** The channel the client bundle calls. */
export const CHANNEL = '/dsh-live-browser'

/** Largest request body accepted, in bytes. */
const MAX_BODY = 24 * 1024 * 1024

/** Default ceiling for one file handed to a page, in bytes. */
const DEFAULT_UPLOAD_MAX = 16 * 1024 * 1024

/** Loopback hostnames, the only ones DSH is expected to serve on. */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Refuse anything that did not come from this server's own page.
 *
 * Three signals, applied in order of how much they are trusted:
 *
 *   - `Sec-Fetch-Site` — set by the browser itself and not settable from page
 *     script, so `same-origin` is a strong positive and `cross-site` a definite
 *     negative.
 *   - `Origin` — attached by the browser to every cross-origin POST. A loopback
 *     origin on this server's port is the plugin's own fetch.
 *   - Neither header present: not a browser request at all. That is the CLI
 *     health check and the tests, so it is allowed; a hostile page always has an
 *     Origin, which is the case being blocked.
 *
 * @param {{headers: Record<string, string | string[] | undefined>}} req
 * @param {number | undefined} port the port this server is listening on
 * @returns {string | undefined} a rejection reason, or undefined to allow
 */
export function authorizeRequest(req, port) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== '') {
    if (site === 'cross-site' || site === 'same-site') return '拒绝来自其他站点的请求'
    if (site !== 'same-origin' && site !== 'none') return `无法识别请求来源：${site}`
    return undefined
  }

  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    if (origin === 'null') return '拒绝来自不透明来源的请求'
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      return '请求来源不是合法地址'
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '请求来源不被允许'
    if (!LOCAL_HOSTS.has(parsed.hostname)) return '拒绝来自其他主机的请求'
    if (port !== undefined && parsed.port !== '' && parsed.port !== String(port)) {
      return '请求来源端口不匹配'
    }
    return undefined
  }

  return undefined
}

function ok(value) {
  return { ok: true, value }
}

/** Guess a MIME type from the extension; file inputs rely on it. */
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/**
 * Read one local file and hand it to the page as base64.
 *
 * @param {{path?: string}} payload
 */
async function readUpload(payload) {
  return readUploadFile(payload?.path)
}

/** Exported so the host half can read uploads without a round trip. */
export async function readUploadFile(rawPath, options = {}) {
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_UPLOAD_MAX
  const raw = String(rawPath ?? '').trim()
  if (raw === '') throw new Error('上传失败：文件路径为空')
  if (!isAbsolute(raw)) throw new Error(`上传失败：需要绝对路径，收到 ${raw}`)
  const path = resolve(raw)
  if (!existsSync(path)) throw new Error(`上传失败：找不到文件 ${path}`)
  const info = statSync(path)
  if (!info.isFile()) throw new Error(`上传失败：不是文件 ${path}`)
  if (info.size === 0) throw new Error(`上传失败：文件是空的 ${path}`)
  if (info.size > maxBytes) {
    throw new Error(
      `上传失败：文件 ${(info.size / 1048576).toFixed(1)}MB 超过 ${(maxBytes / 1048576).toFixed(0)}MB 上限`,
    )
  }
  const bytes = readFileSync(path)
  return {
    name: basename(path),
    size: bytes.length,
    type: MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream',
    base64: bytes.toString('base64'),
  }
}

/**
 * Perform a tab operation through the host.
 *
 * The sidebar owns its tab strip: a guest <webview> cannot create or close its
 * siblings, so these commands are executed by the host against the official
 * sidebar service, then the panel simply reports the new layout.
 *
 * @param {{action?: string, params?: object}} payload
 * @param {() => object | undefined} getSidebar resolves the `sidebarRight` service now
 */
async function tabCommand(payload, getSidebar) {
  const action = String(payload?.action ?? '')
  const params = payload?.params ?? {}
  const sidebar = typeof getSidebar === 'function' ? getSidebar() : getSidebar
  if (sidebar === undefined || sidebar === null) {
    throw new Error('当前 DSH 版本不支持由插件管理侧边栏标签页')
  }
  switch (action) {
    case 'tabNew': {
      if (typeof sidebar.openTab !== 'function') {
        throw new Error('侧边栏不支持打开新标签页')
      }
      // `openTab` takes a tab *kind*; "browser" is the official browser tab.
      sidebar.openTab('browser', params?.url === undefined ? {} : { params: { url: params.url } })
      return { opened: true, kind: 'browser', url: params?.url ?? null }
    }
    case 'tabClose':
    case 'tabActivate':
      // Both need the sidebar's own tab ids, which the official plugin keeps
      // internal. The browser element's own methods cover the common cases, so
      // these report honestly instead of pretending to work.
      throw new Error(
        '侧边栏标签页的关闭/切换需要 DSH 内部标签 id，当前版本未开放；请让用户直接在右侧栏操作',
      )
    default:
      throw new Error(`未知的标签页操作：${action}`)
  }
}

/**
 * List files in the folder DSH's browser saves downloads to.
 *
 * The embedded browser keeps Electron's default behaviour, so files land in the
 * user's Downloads folder unless `downloadsDir` says otherwise. Truncated to the
 * most recent entries.
 */
export function listDownloads(options = {}) {
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 50
  const dir = String(options.dir ?? '').trim() === '' ? defaultDownloadsDir() : String(options.dir)
  if (!existsSync(dir)) return { dir, files: [], note: '找不到下载目录' }
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(dir, entry.name)
      const info = statSync(path)
      return { name: entry.name, path, bytes: info.size, modified: info.mtime.toISOString() }
    })
    .sort((left, right) => right.modified.localeCompare(left.modified))
    .slice(0, limit)
  return { dir, files, count: files.length }
}

/**
 * Write an image the page posted back.
 *
 * The guest page renders on an arbitrary origin and cannot reach the host's
 * filesystem, so it rasterises its own chart and POSTs the data URL here.
 *
 * @param {{dataUrl?: string, name?: string}} payload
 * @param {string} [imageDir] configured destination
 */
function saveImage(payload, imageDir) {
  const dataUrl = String(payload?.dataUrl ?? '')
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.replace(/\s+/g, ''))
  if (match === null) throw new Error('saveImage: 需要 image/png 或 image/jpeg 的 data URL')
  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.length === 0) throw new Error('saveImage: 图片为空')
  const dir = String(imageDir ?? '').trim() === '' ? defaultImageDir() : String(imageDir)
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const slug = String(payload?.name ?? 'image').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60) || 'image'
  const path = join(dir, `${slug}-${stamp}.${match[1]}`)
  writeFileSync(path, bytes)
  return { path, bytes: bytes.length, format: match[1] }
}

function fail(message) {
  return { ok: false, error: { message: String(message) } }
}

/** Clamp a requested long-poll hold into a sane range. */
function normalizeWait(value) {
  const ms = Number(value)
  if (!Number.isFinite(ms)) return 25_000
  return Math.min(Math.max(Math.round(ms), 0), 29_000)
}

/**
 * Answer one panel request.
 *
 * @param {import('./bridge.js').BrowserBridge} bridge
 * @param {string} endpoint endpoint name from the URL
 * @param {object} payload parsed request payload
 * @param {object} [services] host services and resolved config
 */
export async function handleEndpoint(bridge, endpoint, payload, services = {}) {
  const config = services.config ?? {}
  try {
    switch (endpoint) {
      case 'status':
        return ok({ attached: bridge.attached, panels: bridge.panels().length })
      case 'source':
        return ok({ source: AGENT_SOURCE, bytes: AGENT_SOURCE.length })
      case 'page':
        // Read one expression out of the live page. Used to lift an image the
        // page rendered into a canvas (a data URL) back to the host so it can be
        // written to disk: the plugin cannot screenshot the native guest, but the
        // page can draw itself.
        return ok(await bridge.call('evaluate', { expression: String(payload?.expression ?? 'null') }))
      case 'saveImage':
        // Persist an image the page rendered and posted back. The page runs in a
        // sandboxed guest on an arbitrary origin, so this is the only way its own
        // pixels can reach the disk: it POSTs a data URL, this writes the bytes.
        return ok(saveImage(payload, config.imageDir))
      case 'readUpload':
        // Read the bytes of a local file the agent wants to attach to a file
        // input. The page cannot touch the filesystem, and a native picker cannot
        // be driven by an agent, so the bytes travel host -> page as base64.
        return ok(await readUploadFile(payload?.path, { maxBytes: config.uploadMaxBytes }))
      case 'tabCommand':
        // Tab management belongs to the sidebar, so the host performs it.
        return ok(await tabCommand(payload, services.sidebar))
      case 'downloads':
        return ok(listDownloads({ dir: config.downloadsDir }))
      case 'poll':
        // Long poll: the request stays open until this conversation has work or
        // the wait expires, so an idle panel is silent and a queued command is
        // handed over immediately instead of on the next 50 ms tick.
        return ok(
          await bridge.pollWait(
            String(payload?.panelId ?? 'unknown'),
            typeof payload?.sessionId === 'string' ? payload.sessionId : undefined,
            normalizeWait(payload?.waitMs),
          ),
        )
      case 'settle':
        return ok(
          bridge.settle(
            String(payload?.panelId ?? 'unknown'),
            String(payload?.id ?? ''),
            payload?.outcome ?? { ok: false, error: '缺少执行结果' },
          ),
        )
      default:
        return fail(`未知的面板端点：${endpoint}`)
    }
  } catch (error) {
    return fail(error?.message ?? error)
  }
}

/**
 * Mount the panel endpoint on the web server.
 *
 * @param {object} ctx plugin context (must declare `webServer`)
 * @param {import('./bridge.js').BrowserBridge} bridge
 * @param {object} [services] `{ sidebar, config }`; `sidebar` must be a getter
 */
export function registerRpc(ctx, bridge, services = {}) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('[dsh-live-browser] webServer 不可用，浏览器面板端点未挂载')
    return
  }

  const port = Number(webServer.port) > 0 ? Number(webServer.port) : undefined
  const route = {
    kind: 'prefix',
    path: CHANNEL,
    handler: (req, res) => serve(bridge, req, res, { ...services, port }),
  }
  ctx.effect(() => webServer.register(route), 'dsh-live-browser: panel endpoint')
}

/** Read the whole body, capped. */
async function readBody(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > MAX_BODY) throw new Error('请求体过大')
  }
  return body
}

async function serve(bridge, req, res, services = {}) {
  const send = (status, body) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }

  if (req.method !== 'POST') {
    send(405, fail('仅支持 POST'))
    return
  }

  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  if (!pathname.startsWith(`${CHANNEL}/`)) {
    send(404, fail('未知路径'))
    return
  }

  // Gate before parsing: an unauthorised caller learns nothing about the API,
  // not even whether its envelope was well-formed.
  const denied = authorizeRequest(req, services.port)
  if (denied !== undefined) {
    send(403, fail(denied))
    return
  }

  const endpoint = pathname.slice(CHANNEL.length + 1)

  let envelope
  try {
    const body = await readBody(req)
    envelope = body === '' ? {} : JSON.parse(body)
  } catch (error) {
    send(400, fail(`请求体解析失败：${error?.message ?? error}`))
    return
  }

  const rpcId = typeof envelope?.rpcId === 'string' ? envelope.rpcId : 'unknown'
  const result = await handleEndpoint(bridge, endpoint, envelope?.payload, services)
  send(200, { type: 'server-response', rpcId, result })
}
