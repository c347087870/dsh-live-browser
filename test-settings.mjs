/**
 * Settings and request-guard checks.
 *
 * Everything here runs without a browser: these are the behaviours that used to
 * be wrong or missing entirely, so they are asserted in isolation rather than
 * through a page.
 */
import { BrowserBridge } from './lib/bridge.js'
import { registerBrowserTools } from './lib/tools.js'
import { resolveConfig, defaultDownloadsDir, defaultImageDir } from './lib/config.js'
import { handleEndpoint, authorizeRequest } from './lib/rpc.js'

const failures = []
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS ${label}`)
  else { failures.push(label); console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

// ---------------------------------------------------------------------------
// Resolved config: defaults, overrides and clamping
// ---------------------------------------------------------------------------

{
  const defaults = resolveConfig()
  check('confirmSensitive defaults to on', defaults.confirmSensitive === true, String(defaults.confirmSensitive))
  check('allowEval defaults to on', defaults.allowEval === true, String(defaults.allowEval))
  check('autoOpenPanel defaults to on', defaults.autoOpenPanel === true, String(defaults.autoOpenPanel))
  check('snapshot cap defaults to 400', defaults.maxSnapshotNodes === 400, String(defaults.maxSnapshotNodes))
  check('text cap defaults to 12000', defaults.maxTextChars === 12000, String(defaults.maxTextChars))
  check('upload cap defaults to 16MB', defaults.uploadMaxBytes === 16 * 1024 * 1024, String(defaults.uploadMaxBytes))
  check('imageDir falls back to the storage dir', defaults.imageDir === defaultImageDir(), defaults.imageDir)
  check('downloadsDir falls back to Downloads', defaults.downloadsDir === defaultDownloadsDir(), defaults.downloadsDir)
  check('blank directory settings fall back', resolveConfig({ imageDir: '   ' }).imageDir === defaultImageDir())

  const off = resolveConfig({ confirmSensitive: false, allowEval: false, autoOpenPanel: false })
  check('confirmSensitive can be turned off', off.confirmSensitive === false)
  check('allowEval can be turned off', off.allowEval === false)
  check('autoOpenPanel can be turned off', off.autoOpenPanel === false)

  // A bad number must degrade to the default, never to an arbitrary value.
  check('non-numeric limits fall back', resolveConfig({ maxSnapshotNodes: 'abc' }).maxSnapshotNodes === 400)
  check('zero limits are clamped up to 1', resolveConfig({ maxTextChars: 0 }).maxTextChars === 1)
  check('huge limits are clamped', resolveConfig({ maxSnapshotNodes: 999999 }).maxSnapshotNodes <= 5000)
  check('custom timeouts are honoured', resolveConfig({ waitTimeoutMs: 2500 }).waitTimeoutMs === 2500)
}

// ---------------------------------------------------------------------------
// confirmSensitive actually decides whether a question is asked
// ---------------------------------------------------------------------------

{
  const makeCtx = (asked) => ({
    logger: { info() {}, warn() {}, debug() {} },
    tools: { register: (definition) => tools.push(definition) },
    get: (name) => name === 'userQuestions'
      ? { ask: async () => { asked.count += 1; return { answers: [{ selected: ['允许本次操作'] }] } } }
      : undefined,
  })

  const tools = []
  const asked = { count: 0 }
  const bridge = new BrowserBridge({ timeoutMs: 400 })
  registerBrowserTools(makeCtx(asked), { confirmSensitive: true }, bridge, {
    readUpload: async () => ({ name: 'a', type: 'text/plain', base64: '' }),
    downloads: async () => ({ files: [] }),
    openTab: async () => ({}),
    imageDir: process.env.TEMP ?? '.',
  })
  const click = tools.find((tool) => tool.name === 'browser_click')
  const exec = { agent: { session: { id: 's1' } }, callId: 'c', signal: undefined }

  // Nothing is open, so the command fails — but the question must be asked, and
  // asked *before* the page is touched.
  await click.execute({ ref: 'e1', sensitive: true }, exec).catch(() => {})
  check('a sensitive click asks the user while the setting is on', asked.count === 1, String(asked.count))

  const toolsOff = []
  const askedOff = { count: 0 }
  const bridgeOff = new BrowserBridge({ timeoutMs: 400 })
  registerBrowserTools(
    { ...makeCtx(askedOff), tools: { register: (definition) => toolsOff.push(definition) } },
    { confirmSensitive: false },
    bridgeOff,
    { readUpload: async () => ({ name: 'a', type: 'text/plain', base64: '' }), downloads: async () => ({ files: [] }), imageDir: process.env.TEMP ?? '.' },
  )
  const clickOff = toolsOff.find((tool) => tool.name === 'browser_click')
  await clickOff.execute({ ref: 'e1', sensitive: true }, exec).catch(() => {})
  check('the same click asks nothing while the setting is off', askedOff.count === 0, String(askedOff.count))

  bridge.close()
  bridgeOff.close()
}

// ---------------------------------------------------------------------------
// allowEval turns the tool into a refusal
// ---------------------------------------------------------------------------

{
  const tools = []
  const bridge = new BrowserBridge({ timeoutMs: 400 })
  registerBrowserTools(
    {
      logger: { info() {}, warn() {}, debug() {} },
      tools: { register: (definition) => tools.push(definition) },
      get: () => undefined,
    },
    { allowEval: false },
    bridge,
    { readUpload: async () => ({ name: 'a', type: 'text/plain', base64: '' }), downloads: async () => ({ files: [] }), imageDir: process.env.TEMP ?? '.' },
  )
  const evaluate = tools.find((tool) => tool.name === 'browser_eval')
  const result = await evaluate.execute({ expression: '1+1' }, {})
  check('browser_eval refuses when disabled', result.executed === false, JSON.stringify(result))
  check('the refusal names the setting', String(result.reason).includes('allowEval'), result.reason)
  check('the refusal suggests an alternative', String(result.hint).includes('browser_read_text'), result.hint)
  bridge.close()
}

// ---------------------------------------------------------------------------
// The request guard is a same-origin check, not an open endpoint
// ---------------------------------------------------------------------------

{
  const bridge = new BrowserBridge({ timeoutMs: 400 })
  const status = await handleEndpoint(bridge, 'status', {})
  check('status endpoint answers without a page', status.ok === true && status.value.attached === false)

  // A missing panel is unbound, so a save with an invalid data URL must still be
  // rejected rather than written.
  const badImage = await handleEndpoint(bridge, 'saveImage', { dataUrl: 'nope' }, { config: resolveConfig() })
  check('an invalid image payload is refused', badImage.ok === false, JSON.stringify(badImage))

  const verdict = authorizeRequest({ headers: { 'sec-fetch-site': 'cross-site' } }, 1234)
  check('a cross-site request is refused', verdict !== undefined, String(verdict))
  const sameSite = authorizeRequest({ headers: { 'sec-fetch-site': 'same-origin' } }, 1234)
  check('a same-origin request passes', sameSite === undefined, String(sameSite))
  const foreignOrigin = authorizeRequest({ headers: { origin: 'https://evil.test' } }, 1234)
  check('a foreign origin is refused', foreignOrigin !== undefined, String(foreignOrigin))
  const loopback = authorizeRequest({ headers: { origin: 'http://127.0.0.1:1234' } }, 1234)
  check('a loopback origin on our port passes', loopback === undefined, String(loopback))
  const wrongPort = authorizeRequest({ headers: { origin: 'http://127.0.0.1:9999' } }, 1234)
  check('a loopback origin on another port is refused', wrongPort !== undefined, String(wrongPort))

  bridge.close()
}

console.log(failures.length === 0 ? '\nSETTINGS AND GUARDS OK' : `\nSETTINGS AND GUARDS FAILED (${failures.length})`)
process.exit(failures.length === 0 ? 0 : 1)
