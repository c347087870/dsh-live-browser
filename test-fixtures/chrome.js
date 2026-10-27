/**
 * Chrome/Edge discovery, profile synchronisation and process lifecycle.
 *
 * Login state cannot be shared live: Chrome keeps its cookie database under an
 * exclusive lock while it runs, and since Chrome 136 a remote-debugging port is
 * refused for the default user-data directory. The working model is therefore:
 *
 *   close the user's browser -> copy the login-bearing profile files into a
 *   plugin-owned user-data dir -> relaunch that browser against the copy with
 *   --remote-debugging-port.
 *
 * The copy is a snapshot taken at takeover time and stays the plugin's own
 * browsing profile from then on, so sessions established there keep working.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { copyFile, cp, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeCdp } from './cdp.js'

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
]

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

/** Candidate profile files worth copying: identity, cookies, storage, history. */
const PROFILE_ITEMS = [
  'Preferences',
  'Secure Preferences',
  'Network',
  'Local Storage',
  'Session Storage',
  'IndexedDB',
  'Web Data',
  'Login Data',
  'History',
  'Bookmarks',
  'Favicons',
  'Sessions',
]

export const DEFAULT_USER_DATA_DIR = `${homedir().replace(/\\/g, '/')}/.dsh/storages/dsh-live-browser/chrome-profile`

/** First existing executable out of the candidate list. */
export function detectBrowserExplicit(preferred) {
  const list = preferred !== undefined && preferred !== '' ? [preferred] : [...CHROME_CANDIDATES, ...EDGE_CANDIDATES]
  for (const candidate of list) {
    try {
      if (candidate !== '' && existsSync(candidate)) return candidate
    } catch {
      /* ignore unreadable candidate */
    }
  }
  return undefined
}

/** The user's real browser profile root (`.../User Data`). */
export function defaultUserDataRoot(executable) {
  if (/msedge\.exe$/i.test(executable)) {
    return join(process.env.LOCALAPPDATA ?? '', 'Microsoft/Edge/User Data')
  }
  return join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/User Data')
}

function run(file, args, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error })
    })
  })
}

/** Names of running processes for one image name (e.g. chrome.exe). */
async function runningProcesses(imageName) {
  const result = await run('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/NH', '/FO', 'CSV'])
  if (!result.ok) return []
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('"'))
    .map((line) => {
      const cells = line.split('","').map((cell) => cell.replace(/^"|"$/g, ''))
      return { name: cells[0], pid: Number(cells[1]) }
    })
    .filter((entry) => entry.name.toLowerCase() === imageName.toLowerCase() && Number.isFinite(entry.pid))
}

export class BrowserLauncher {
  constructor(cfg) {
    this.cfg = cfg
  }

  get executable() {
    return detectBrowserExplicit(this.cfg.chromePath)
  }

  get imageName() {
    const exe = this.executable
    if (exe === undefined) return 'chrome.exe'
    return /msedge\.exe$/i.test(exe) ? 'msedge.exe' : 'chrome.exe'
  }

  get userDataDir() {
    return this.cfg.userDataDir ?? DEFAULT_USER_DATA_DIR
  }

  /** Is the debugging endpoint of our browser answering right now? */
  async probe() {
    return probeCdp(this.cfg.debugPort)
  }

  async isRunning() {
    return (await this.probe()) !== undefined
  }

  /** Is the user's everyday browser running (any process of that image)? */
  async everydayBrowserRunning() {
    return (await runningProcesses(this.imageName)).length > 0
  }

  /** Launch the plugin-owned browser against the plugin profile. */
  async launch({ url } = {}) {
    const exe = this.executable
    if (exe === undefined) {
      throw new Error('未找到 Chrome/Edge 可执行文件；请在插件配置里设置 chromePath 为浏览器 exe 的绝对路径')
    }
    mkdirSync(this.userDataDir, { recursive: true })
    const args = [
      `--remote-debugging-port=${this.cfg.debugPort}`,
      `--user-data-dir=${this.userDataDir}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      '--ignore-certificate-errors',
      '--allow-insecure-localhost',
      '--disable-popup-blocking',
      '--restore-last-session',
      '--start-maximized',
    ]
    if (url !== undefined && url !== '') args.push(url)
    const { spawn } = await import('node:child_process')
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      const version = await probeCdp(this.cfg.debugPort)
      if (version !== undefined) return { executable: exe, userDataDir: this.userDataDir, version }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    throw new Error(`浏览器已启动，但 ${this.cfg.debugPort} 端口在 25 秒内没有就绪`)
  }

  /**
   * Close the everyday browser politely, then forcefully if it refuses.
   *
   * The polite path matters for login state: Chrome flushes its cookie store on
   * a normal exit, so cookies created since the last save survive the copy. A
   * taskkill /F skips that flush and silently drops recent logins, which shows
   * up later as "the site is signed out" rather than as a copy error.
   */
  async closeEverydayBrowser({ graceMs = 12_000 } = {}) {
    const before = await runningProcesses(this.imageName)
    if (before.length === 0) return { closed: 0, forced: false }
    // taskkill without /F posts WM_CLOSE to every window: a graceful exit.
    await run('taskkill', ['/IM', this.imageName])
    const deadline = Date.now() + graceMs
    while (Date.now() < deadline) {
      const left = await runningProcesses(this.imageName)
      if (left.length === 0) {
        // Give Chrome a moment to finish writing its profile after the last
        // window disappears, so the copy sees flushed files.
        await new Promise((resolve) => setTimeout(resolve, 1500))
        return { closed: before.length, forced: false }
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const left = await runningProcesses(this.imageName)
    if (left.length > 0) {
      await run('taskkill', ['/F', '/T', '/IM', this.imageName])
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    return { closed: before.length, forced: left.length > 0, warning: left.length > 0 ? '浏览器没有正常退出，最近的 Cookie 可能没有落盘' : undefined }
  }

  /**
   * Copy the login-bearing parts of the everyday profile into the plugin
   * profile. Must run while the source browser is closed.
   */
  async syncProfile({ root, profile = 'Default' } = {}) {
    const sourceRoot = root ?? defaultUserDataRoot(this.executable ?? '')
    const sourceProfile = join(sourceRoot, profile)
    if (!existsSync(sourceProfile)) {
      return { synced: false, reason: `源配置不存在：${sourceProfile}`, copied: [] }
    }
    const targetRoot = this.userDataDir
    const targetProfile = join(targetRoot, profile)
    mkdirSync(targetProfile, { recursive: true })

    const copied = []
    const skipped = []
    const localState = join(sourceRoot, 'Local State')
    if (existsSync(localState)) {
      try {
        await copyFile(localState, join(targetRoot, 'Local State'))
        copied.push('Local State')
      } catch (error) {
        skipped.push({ item: 'Local State', error: describe(error) })
      }
    }
    for (const item of PROFILE_ITEMS) {
      const from = join(sourceProfile, item)
      const to = join(targetProfile, item)
      if (!existsSync(from)) continue
      try {
        const info = await stat(from)
        if (info.isDirectory()) {
          await cp(from, to, { recursive: true, force: true, errorOnExist: false, dereference: false })
        } else {
          mkdirSync(targetProfile, { recursive: true })
          await copyFile(from, to)
        }
        copied.push(item)
      } catch (error) {
        skipped.push({ item, error: describe(error) })
      }
    }
    const cookies = join(targetProfile, 'Network', 'Cookies')
    const cookiesOk = existsSync(cookies) && safeSize(cookies) > 0
    if (!cookiesOk) {
      // A zero-byte Cookies file means the source database was locked (Chrome
      // still running): the copy would launch signed out of every site, so say
      // so instead of reporting a successful sync.
      skipped.push({
        item: 'Network/Cookies',
        error: existsSync(join(sourceProfile, 'Network', 'Cookies'))
          ? 'Cookie 数据库为空或不可读——浏览器没关干净，登录态没有复制过来'
          : '源配置里没有 Cookie 数据库',
      })
    }
    return {
      synced: copied.length > 0,
      loginStateCopied: cookiesOk,
      source: sourceProfile,
      target: targetProfile,
      copied,
      skipped,
      cookiesPresent: existsSync(cookies),
      cookiesBytes: cookiesOk ? safeSize(cookies) : 0,
    }
  }

  /**
   * Take over the everyday browser: close it, sync the profile, relaunch with a
   * debug port.
   *
   * @param options.url - page to open after the relaunch.
   * @param options.sourceRoot - user-data root to copy from; defaults to the
   *   real browser profile. Tests point this at a throwaway profile.
   */
  async takeover({ url, sourceRoot, profile = 'Default' } = {}) {
    const steps = []
    const already = await this.probe()
    if (already !== undefined) {
      steps.push({ step: 'probe', result: 'debug端口已就绪，无需接管' })
      return { tookOver: false, alreadyRunning: true, steps }
    }
    const closed = await this.closeEverydayBrowser()
    steps.push({ step: 'close', ...closed })
    const sync = await this.syncProfile({ root: sourceRoot, profile })
    steps.push({
      step: 'sync',
      synced: sync.synced,
      loginStateCopied: sync.loginStateCopied,
      copied: sync.copied,
      skipped: sync.skipped,
      cookiesBytes: sync.cookiesBytes,
    })
    const launched = await this.launch({ url })
    steps.push({ step: 'launch', executable: launched.executable })
    return {
      tookOver: true,
      forcedClose: closed.forced === true,
      loginStateSynced: sync.loginStateCopied === true,
      warning: sync.loginStateCopied === true
        ? undefined
        : '浏览器已启动，但登录态没有复制成功（Cookie 数据库为空）。请在面板里重新登录需要的站点，或关掉浏览器后再点一次「接管 Chrome」。',
      steps,
    }
  }

  /** Remove the plugin profile (signs the plugin browser out of everything). */
  async resetProfile() {
    await rm(this.userDataDir, { recursive: true, force: true }).catch(() => {})
    return { removed: this.userDataDir }
  }
}

function describe(error) {
  if (error && typeof error === 'object' && 'code' in error) return `${error.code}: ${error.message}`
  return String(error?.message ?? error)
}

function safeSize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** Default download directory for the plugin browser. */
export function defaultDownloadDir() {
  return join(tmpdir(), 'dsh-live-browser-downloads')
}

/** List a directory newest-first without throwing. */
export function listDir(dir) {
  try {
    return readdirSync(dir)
      .map((name) => {
        const info = statSync(join(dir, name))
        return { name, path: join(dir, name), bytes: info.size, modifiedAt: info.mtime.toISOString() }
      })
      .sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1))
  } catch {
    return []
  }
}
