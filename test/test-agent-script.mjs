/**
 * Exercise the injected agent script against a real page in a real browser.
 *
 * The script is the only thing that touches page DOM, so this test is the one
 * that proves the agent can actually read and drive a page. It runs in Chrome
 * via CDP here purely as a test harness; the shipped plugin does not use CDP.
 */
import { BrowserLauncher } from './fixtures/chrome.js'
import { testBrowserConfig } from './browser-config.mjs'
import { BrowserHub } from './fixtures/browser.js'
import { AGENT_SOURCE } from '../lib/agent-script.js'

const cfg = testBrowserConfig
const quiet = { info: () => {}, warn: console.warn, debug: () => {} }
const launcher = new BrowserLauncher(cfg)
const hub = new BrowserHub(cfg, launcher, quiet)

const failures = []
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS ${label}`)
  else { failures.push(label); console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

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

// A local fixture page: no network, fully deterministic.
const fixture = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><title>Agent Fixture</title></head>
<body>
  <h1>Fixture heading</h1>
  <p id="para">Some readable body text for the read_text tool.</p>
  <label for="name">Your name</label>
  <input id="name" type="text" placeholder="name here" />
  <button id="go" onclick="document.getElementById('out').textContent='clicked:'+ (document.getElementById('name').value||'')">Go</button>
  <div id="out">not clicked</div>
  <select id="pick"><option value="a">Alpha</option><option value="b">Beta</option></select>
  <a id="link" href="https://example.com/">a link</a>
  <div style="height:2000px">tall</div>
</body></html>`)}`

await hub.navigate(tab.targetId, fixture)

const run = async (method, params = {}) => {
  const expression = `(async () => { ${AGENT_SOURCE}; return await window.__dshBrowserAgent[${JSON.stringify(method)}](${JSON.stringify(params)}); })()`
  const result = await hub.evalJs(tab.targetId, expression)
  // evalJs reports a page-thrown error as {ok:false, error} rather than throwing.
  if (result.ok === false) throw new Error(String(result.error))
  if (result.exceptionDetails) throw new Error(String(result.exceptionDetails.text ?? 'page exception'))
  return result.value
}

// 1. install
const installed = await hub.evalJs(tab.targetId, AGENT_SOURCE)
check('script installs on the page', installed.value?.installed === true, JSON.stringify(installed.value))

// 2. state
const state = await run('state')
check('state reports the url', String(state.url).startsWith('data:text/html'), state.url)
check('state reports a viewport', state.viewport.width > 0 && state.viewport.height > 0, JSON.stringify(state.viewport))

// 3. snapshot
const snap = await run('snapshot')
const h1 = snap.nodes.find((node) => node.role === 'heading')
const input = snap.nodes.find((node) => node.tag === 'input')
const button = snap.nodes.find((node) => node.tag === 'button')
check('snapshot finds the heading', h1?.name === 'Fixture heading', JSON.stringify(h1))
check('snapshot finds the input', input !== undefined && typeof input.value === 'string')
check('snapshot finds the button', button?.name === 'Go', JSON.stringify(button))
check('snapshot nodes carry refs', snap.nodes.every((node) => typeof node.ref === 'string' && node.ref.startsWith('e')))

// 4. readText
const text = await run('readText')
check('read_text returns body copy', text.text.includes('Some readable body text'), text.text.slice(0, 60))

// 5. type into the input by ref
const typed = await run('type', { ref: input.ref, text: 'deepseek' })
check('type sets the input value', typed.value === 'deepseek', JSON.stringify(typed))

// 6. click the button by ref; its handler writes the input back out
const clicked = await run('click', { ref: button.ref })
check('click reports the clicked element', clicked.clicked?.tag === 'button', JSON.stringify(clicked.clicked))
const afterClick = await run('readText', { selector: '#out' })
check('click ran the page handler', afterClick.text.includes('clicked:deepseek'), afterClick.text)

// 7. select
const selected = await run('select', { selector: '#pick', value: 'b' })
check('select changes the option', selected.value === 'b' && selected.label === 'Beta', JSON.stringify(selected))

// 8. scroll
const scrolled = await run('scroll', { dy: 500 })
check('scroll moves the viewport', scrolled.viewport.scrollY > 0, JSON.stringify(scrolled.viewport))

// 9. evaluate
const evaluated = await run('evaluate', { expression: 'document.title' })
check('evaluate returns a page value', evaluated === 'Agent Fixture', String(evaluated))

// 10. wait (immediate match)
const waited = await run('wait', { selector: '#para', timeoutMs: 2000 })
check('wait matches an existing selector', waited.matched === true)

// 11. wait (timeout, must report matched:false without throwing)
const notWaited = await run('wait', { selector: '#does-not-exist', timeoutMs: 400 })
check('wait reports a miss cleanly', notWaited.matched === false, JSON.stringify(notWaited))

// 12. errors are actionable, not silent
let typeError
try {
  await run('type', { ref: 'e99999', text: 'x' })
} catch (error) {
  typeError = String(error.message)
}
check('stale ref produces a clear error', String(typeError).includes('快照引用已失效'), typeError)

await hub.close()
console.log(failures.length === 0 ? '\nAGENT SCRIPT OK' : `\nAGENT SCRIPT FAILED (${failures.length})`)
process.exit(failures.length === 0 ? 0 : 1)
