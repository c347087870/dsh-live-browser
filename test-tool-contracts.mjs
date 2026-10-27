/**
 * Contract test: every tool must return losslessly JSON-serialisable output.
 *
 * DSH rejects a tool result that contains `undefined`, functions, or cycles with
 * "value is not lossless JSON", which surfaces to the user as a tool error. A
 * marketplace plugin cannot ship a tool that throws when its precondition simply
 * is not met, so this drives every tool through its "nothing open" path.
 */
import { BrowserBridge } from './lib/bridge.js'
import { registerBrowserTools } from './lib/tools.js'

const tools = []
const ctx = {
  logger: { info() {}, warn() {}, debug() {} },
  tools: { register: (definition) => tools.push(definition) },
  get: () => undefined,
}
const bridge = new BrowserBridge({ timeoutMs: 300 })
registerBrowserTools(ctx, {}, bridge, {
  storageRoot: process.env.TEMP ?? '.',
  readUpload: async () => ({ name: 'a.txt', type: 'text/plain', base64: 'aGk=' }),
  downloads: async () => ({ dir: 'C:/dl', files: [] }),
  openTab: async () => ({ opened: true }),
})

/** True when a value can survive JSON without losing information. */
const isLossless = (value) => {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    return { ok: false, reason: 'not serialisable' }
  }
  if (text === undefined) return { ok: false, reason: 'stringifies to undefined' }
  const walk = (node, path) => {
    if (node === undefined) return { ok: false, reason: `${path} is undefined` }
    if (typeof node === 'function') return { ok: false, reason: `${path} is a function` }
    if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        const nested = walk(child, `${path}.${key}`)
        if (!nested.ok) return nested
      }
    }
    return { ok: true }
  }
  return walk(value, '$')
}

/** Arguments that exercise each tool without needing a page. */
const probes = {
  browser_status: {},
  browser_open_panel: {},
  browser_navigate: { url: 'https://example.com' },
  browser_back: {},
  browser_forward: {},
  browser_reload: {},
  browser_snapshot: {},
  browser_read_text: {},
  browser_eval: { expression: '1+1' },
  browser_click: { ref: 'e1' },
  browser_type: { ref: 'e1', text: 'x' },
  browser_press: { key: 'Enter' },
  browser_select: { ref: 'e1', value: 'a' },
  browser_hover: { ref: 'e1' },
  browser_scroll: {},
  browser_wait: { selector: 'body' },
  browser_screenshot: {},
  browser_tabs: {},
  browser_tab_new: {},
  browser_tab_close: {},
  browser_tab_activate: { tab: 't' },
  browser_upload: { files: ['C:/tmp/a.txt'] },
  browser_downloads: {},
  browser_confirm: { action: 'test' },
  browser_reset_profile: {},
}

const failures = []
for (const tool of tools) {
  const args = probes[tool.name] ?? {}
  try {
    const value = await tool.execute(args, { agent: undefined, callId: 'c', signal: undefined })
    const check = isLossless(value)
    if (check.ok) console.log(`PASS ${tool.name}`)
    else {
      failures.push(tool.name)
      console.log(`FAIL ${tool.name} — ${check.reason}`)
    }
  } catch (error) {
    // Errors are acceptable only on the documented "could not open" path.
    const message = String(error?.message ?? error)
    if (message.includes('没能打开') || message.includes('PANEL_NOT_OPEN')) {
      console.log(`PASS ${tool.name} (fails closed with an explanation)`)
    } else {
      failures.push(tool.name)
      console.log(`FAIL ${tool.name} — threw: ${message.slice(0, 120)}`)
    }
  }
}

bridge.close()
console.log(failures.length === 0 ? '\nTOOL CONTRACTS OK' : `\nTOOL CONTRACTS FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
