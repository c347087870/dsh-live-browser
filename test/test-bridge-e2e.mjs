/**
 * End-to-end check of the new architecture, without a DSH window:
 *
 *   tool-level call -> bridge queue -> simulated panel poll -> page execution
 *                   -> settle -> tool result
 *
 * The "panel" here is a stand-in that uses the real injected agent script
 * against a real page in real Chrome, so this proves the full path works end to
 * end; only the DSH <webview> host is replaced by a test harness.
 */
import { BrowserBridge } from '../lib/bridge.js'
import { AGENT_SOURCE } from '../lib/agent-script.js'
import { BrowserHub } from './fixtures/browser.js'
import { BrowserLauncher } from './fixtures/chrome.js'
import { testBrowserConfig } from './browser-config.mjs'

const cfg = testBrowserConfig
const hub = new BrowserHub(cfg, new BrowserLauncher(cfg), { info() {}, warn() {}, debug() {} })
try {
  await hub.ensure()
} catch (error) {
  if (error?.code === 'BROWSER_NOT_RUNNING') {
    // Nothing to drive. Report the precondition plainly and let the runner
    // count this as skipped rather than passed or failed.
    console.log('SKIP: no browser on the debug port; start one with node scripts/ensure-browser.mjs')
    process.exit(0)
  }
  throw error
}
const tabs = await hub.listTabs()
const tab = await hub.resolveTab(tabs[0].targetId)

const fixture = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><title>Bridge Fixture</title></head>
<body>
  <h1>Bridge fixture</h1>
  <input id="q" type="text" placeholder="search" />
  <button id="go" onclick="document.getElementById('out').textContent='ran:'+(document.getElementById('q').value||'')">Go</button>
  <div id="out">idle</div>
</body></html>`)}`
await hub.navigate(tab.targetId, fixture)
await hub.evalJs(tab.targetId, AGENT_SOURCE)

const failures = []
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS ${label}`)
  else { failures.push(label); console.log(`FAIL ${label}${detail === undefined ? '' : ` 鈥?${detail}`}`) }
}

const bridge = new BrowserBridge({ timeoutMs: 10000 })

/** Simulated panel: polls once and executes one command on the page. */
const panelOnce = async (panelId = 'test-panel') => {
  const command = bridge.poll(panelId)
  if (command === null) return undefined
  try {
    const params = { ...(command.params ?? {}) }
    delete params.tab
    const expression = `(async () => { ${AGENT_SOURCE}; return await window.__dshBrowserAgent[${JSON.stringify(command.method)}](${JSON.stringify(params)}); })()`
    const result = await hub.evalJs(tab.targetId, expression)
    if (result.ok === false) throw new Error(String(result.error))
    bridge.settle(panelId, command.id, { ok: true, value: result.value })
    return result.value
  } catch (error) {
    bridge.settle(panelId, command.id, { ok: false, error: String(error?.message ?? error) })
    throw error
  }
}

/** Run a tool-level call against the bridge, pumping the simulated panel. */
const viaBridge = async (method, params) => {
  const pending = bridge.call(method, params, { panelWaitMs: 0 })
  // Pump until the call settles or the queue drains.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await panelOnce()
    const settled = await Promise.race([
      pending.then((value) => ({ done: true, value })),
      new Promise((resolve) => setTimeout(() => resolve({ done: false }), 30)),
    ])
    if (settled.done) return settled.value
  }
  return pending
}

// 1. The panel reports itself attached after its first poll.
bridge.poll('test-panel')
check('panel becomes attached after polling', bridge.attached === true)
check('bridge lists the polling panel', bridge.panels().length === 1)

// 2. A page command round-trips through the queue.
const state = await viaBridge('state', {})
check('state round-trips through the bridge', String(state.url).startsWith('data:text/html'), state.url)

// 3. Type then click; the page's own handler proves the events were real.
const snap = await viaBridge('snapshot', {})
const input = snap.nodes.find((node) => node.tag === 'input')
const button = snap.nodes.find((node) => node.tag === 'button')
check('snapshot over the bridge finds the input', input !== undefined)
check('snapshot over the bridge finds the button', button?.name === 'Go')

const typed = await viaBridge('type', { ref: input.ref, text: 'deepseek' })
check('type over the bridge sets the value', typed.value === 'deepseek', JSON.stringify(typed))

await viaBridge('click', { ref: button.ref })
const out = await viaBridge('readText', { selector: '#out' })
check('click over the bridge ran the page handler', out.text.includes('ran:deepseek'), out.text)

// 4. A failing command surfaces a clear error to the caller instead of hanging.
let failure
try {
  await viaBridge('type', { ref: 'e999999', text: 'x' })
} catch (error) {
  failure = String(error?.message ?? error)
}
check('a page error reaches the caller', String(failure).includes('\u5feb\u7167\u5f15\u7528\u5df2\u5931\u6548'), failure)

// 5. With no panel polling, calls fail fast with an actionable message.
const other = new BrowserBridge({ timeoutMs: 5000 })
let noPanel
try {
  await other.call('state', {}, { panelWaitMs: 0 })
} catch (error) {
  noPanel = { code: error.code, message: error.message }
}
check('no panel yields PANEL_NOT_OPEN', noPanel?.code === 'PANEL_NOT_OPEN', JSON.stringify(noPanel))
check('the message tells the user what to do', String(noPanel?.message).includes('\u53f3\u4fa7\u680f'), noPanel?.message)

bridge.close()
other.close()
await hub.close()
console.log(failures.length === 0 ? '\nBRIDGE END-TO-END OK' : `\nBRIDGE END-TO-END FAILED (${failures.length})`)
process.exit(failures.length === 0 ? 0 : 1)

