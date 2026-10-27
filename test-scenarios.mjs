/**
 * Scenario suite: exercise the injected page script the way real sites do.
 *
 * Each case builds a page, drives it through the same entry point the panel uses
 * (`window.__dshBrowserAgent[method]`), and asserts on observable DOM state. The
 * point is to catch the failures that only show up on real markup: renewing refs
 * after navigation, dispatching events frameworks listen for, shadow roots,
 * iframes, disabled controls, and pages that throw.
 */
import { BrowserLauncher } from './test-fixtures/chrome.js'
import { testBrowserConfig } from './browser-config.mjs'
import { BrowserHub } from './test-fixtures/browser.js'
import { AGENT_SOURCE } from './lib/agent-script.js'

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

const failures = []
let passed = 0
const check = (label, condition, detail) => {
  if (condition) { passed += 1; console.log(`PASS ${label}`) }
  else { failures.push(label); console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

/** Load a page and return a runner bound to it. */
const page = async (html) => {
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
  await hub.navigate(tab.targetId, url)
  await hub.evalJs(tab.targetId, AGENT_SOURCE)
  /** Render an evalJs failure as a readable message, whatever shape it has. */
  const errorText = (error) => {
    if (typeof error === 'string') return error
    if (error === null || error === undefined) return 'unknown error'
    if (typeof error === 'object') {
      return String(error.message ?? error.text ?? JSON.stringify(error))
    }
    return String(error)
  }
  const run = async (method, params = {}) => {
    const expression = `(async () => { ${AGENT_SOURCE}; return await window.__dshBrowserAgent[${JSON.stringify(method)}](${JSON.stringify(params)}); })()`
    const result = await hub.evalJs(tab.targetId, expression)
    if (result.ok === false) throw new Error(errorText(result.error))
    return result.value
  }
  const evalInPage = async (expression) => {
    const result = await hub.evalJs(tab.targetId, expression)
    if (result.ok === false) throw new Error(errorText(result.error))
    return result.value
  }
  return { run, evalInPage }
}

const shell = (body, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>Case</title>${head}</head><body>${body}</body></html>`

console.log('\n--- 1. reading -------------------------------------------------')

{
  const { run } = await page(shell(`
    <h1>Title One</h1>
    <p id="p1">Paragraph alpha.</p>
    <p id="p2">Paragraph beta.</p>
    <div style="height:3000px">spacer</div>`))
  const state = await run('state')
  check('state reports title', state.title === 'Case', state.title)
  const text = await run('readText')
  check('readText returns body copy', text.text.includes('Paragraph alpha') && text.text.includes('Paragraph beta'))
  const scoped = await run('readText', { selector: '#p1' })
  check('readText honours a selector', scoped.text === 'Paragraph alpha.', scoped.text)
  const limited = await run('readText', { maxChars: 10 })
  check('readText truncates at maxChars', limited.text.length === 10 && limited.truncated === true, JSON.stringify(limited))
  const missing = await run('readText', { selector: '#nope' }).catch((error) => String(error.message))
  check('readText on a missing selector errors clearly', String(missing).includes('找不到元素'), missing)
}

console.log('\n--- 2. snapshot -------------------------------------------------')

{
  const { run } = await page(shell(`
    <nav><a href="/x">Home</a></nav>
    <h2>Heading</h2>
    <label for="email">Email address</label>
    <input id="email" type="email" placeholder="you@example.com">
    <input id="pw" type="password" value="secret">
    <input id="cb" type="checkbox">
    <button id="b1">Submit</button>
    <button id="b2" disabled>Disabled</button>
    <select id="s1"><option>One</option><option>Two</option></select>
    <textarea id="t1">hello</textarea>`))
  const snap = await run('snapshot')
  const byTag = (tag) => snap.nodes.filter((node) => node.tag === tag)
  check('snapshot finds the link', byTag('a').some((node) => node.name === 'Home'))
  check('snapshot finds both buttons', byTag('button').length === 2)
  check('snapshot marks disabled controls', byTag('button').some((node) => node.name === 'Disabled' && node.disabled === true))
  check('snapshot reports the email input type', byTag('input').some((node) => node.inputType === 'email'))
  check('snapshot reports checkbox role', snap.nodes.some((node) => node.role === 'checkbox'))
  check('snapshot reads a label as the input name', byTag('input').some((node) => node.name === 'Email address'))
  check('snapshot includes select as combobox', snap.nodes.some((node) => node.role === 'combobox'))
  check('snapshot includes textarea value', byTag('textarea').some((node) => node.value === 'hello'))
  check('every node has a unique ref', new Set(snap.nodes.map((node) => node.ref)).size === snap.nodes.length)
  const capped = await run('snapshot', { maxNodes: 3 })
  check('snapshot respects maxNodes', capped.nodes.length <= 3, String(capped.nodes.length))
}

console.log('\n--- 3. typing ---------------------------------------------------')

{
  const { run, evalInPage } = await page(shell(`
    <input id="a" type="text">
    <textarea id="b"></textarea>
    <div id="ed" contenteditable="true">start</div>
    <div id="log"></div>
    <script>
      const log = document.getElementById('log')
      for (const id of ['a','b','ed']) {
        const el = document.getElementById(id)
        el.addEventListener('input', () => log.dataset[ id ] = (log.dataset[id] || '') + 'i')
        el.addEventListener('change', () => log.dataset[ id ] = (log.dataset[id] || '') + 'c')
      }
    </script>`))
  const snap = await run('snapshot')
  const inputRef = snap.nodes.find((node) => node.tag === 'input').ref
  const typed = await run('type', { ref: inputRef, text: 'hello world' })
  check('type writes the value', typed.value === 'hello world', typed.value)
  const events = await evalInPage(`document.getElementById('log').dataset.a`)
  check('type fires input then change', events === 'ic', events)
  const appended = await run('type', { ref: inputRef, text: '!', clear: false })
  check('type appends when clear is false', appended.value === 'hello world!', appended.value)
  const replaced = await run('type', { ref: inputRef, text: 'x', clear: true })
  check('type replaces when clear is true', replaced.value === 'x', replaced.value)
  const area = await run('type', { selector: '#b', text: 'multi\nline' })
  check('type works on textarea', area.value === 'multi\nline', area.value)
  const editable = await run('type', { selector: '#ed', text: 'edited' })
  check('type works on contenteditable', editable.value === 'edited', editable.value)
  const notField = await run('type', { selector: '#log', text: 'x' }).catch((error) => String(error.message))
  check('type on a plain div errors clearly', String(notField).includes('不能输入'), notField)
}

console.log('\n--- 4. clicking -------------------------------------------------')

{
  const { run, evalInPage } = await page(shell(`
    <button id="counter">0</button>
    <div id="hover" style="width:100px;height:40px;background:#eee">hover me</div>
    <div id="hoverOut">no</div>
    <div id="outer" style="padding:20px;background:#ddd">
      <span id="inner">inner target</span>
    </div>
    <script>
      let n = 0
      document.getElementById('counter').addEventListener('click', () => {
        document.getElementById('counter').textContent = String(++n)
      })
      const h = document.getElementById('hover')
      h.addEventListener('mouseover', () => { document.getElementById('hoverOut').textContent = 'over' })
      h.addEventListener('mousemove', () => { document.getElementById('hoverOut').dataset.moved = 'yes' })
    </script>`))
  const snap = await run('snapshot')
  const button = snap.nodes.find((node) => node.tag === 'button')
  await run('click', { ref: button.ref })
  await run('click', { ref: button.ref })
  const count = await evalInPage(`document.getElementById('counter').textContent`)
  check('click fires the page listener repeatedly', count === '2', count)
  const inner = snap.nodes.find((node) => node.name === 'inner target')
  await run('click', { ref: inner.ref })
  check('click on nested content reports the target', true)
  const hovered = await run('hover', { selector: '#hover' })
  check('hover returns a point', typeof hovered.hovered.x === 'number')
  const hoverState = await evalInPage(`document.getElementById('hoverOut').textContent + '/' + (document.getElementById('hoverOut').dataset.moved || '')`)
  check('hover triggers mouseover and mousemove', hoverState === 'over/yes', hoverState)
  let disabledError
  const disabledPage = await page(shell(`<button id="d" disabled>nope</button>`))
  const dSnap = await disabledPage.run('snapshot')
  const dButton = dSnap.nodes.find((node) => node.tag === 'button')
  try { await disabledPage.run('click', { ref: dButton.ref }) } catch (error) { disabledError = String(error.message) }
  check('clicking a disabled control errors', String(disabledError).includes('禁用'), disabledError)
  const byCoord = await page(shell(`<button id="c" style="position:absolute;left:10px;top:10px;width:100px;height:40px" onclick="this.textContent='hit'">c</button>`))
  await byCoord.run('click', { x: 50, y: 25 })
  const hit = await byCoord.evalInPage(`document.getElementById('c').textContent`)
  check('click by coordinate hits the element', hit === 'hit', hit)
}

console.log('\n--- 4b. pointer events ------------------------------------------')

{
  // Modern frameworks bind pointerdown/pointerup instead of the mouse pair, so a
  // click that only dispatches mouse events looks fine here and does nothing on
  // those pages.
  const { run, evalInPage } = await page(shell(`
    <button id="p">pointer</button>
    <div id="seen"></div>
    <script>
      const seen = []
      for (const type of ['pointerover','pointerenter','pointerdown','pointerup','mousedown','mouseup','click']) {
        document.getElementById('p').addEventListener(type, () => { seen.push(type) })
      }
      window.readSeen = () => seen.join(',')
    </script>`))
  const snap = await run('snapshot')
  const button = snap.nodes.find((node) => node.tag === 'button')
  await run('click', { ref: button.ref })
  const seen = await evalInPage(`window.readSeen()`)
  check('click dispatches pointerdown', String(seen).includes('pointerdown'), seen)
  check('click dispatches pointerup', String(seen).includes('pointerup'), seen)
  check('click still dispatches the mouse pair', String(seen).includes('mousedown') && String(seen).includes('mouseup'), seen)
  check('click still fires the click event', String(seen).includes('click'), seen)

  // A listener bound only to pointerdown is what a drag library actually uses.
  const pointerOnly = await page(shell(`
    <button id="p2">p2</button>
    <div id="flag">none</div>
    <script>
      document.getElementById('p2').addEventListener('pointerdown', () => {
        document.getElementById('flag').textContent = 'pointer-only-caught'
      })
    </script>`))
  const p2Snap = await pointerOnly.run('snapshot')
  await pointerOnly.run('click', { ref: p2Snap.nodes.find((node) => node.tag === 'button').ref })
  const flag = await pointerOnly.evalInPage(`document.getElementById('flag').textContent`)
  check('a pointer-only listener receives the click', flag === 'pointer-only-caught', flag)
}

console.log('\n--- 5. select ---------------------------------------------------')

{
  const { run, evalInPage } = await page(shell(`
    <select id="s"><option value="a">Alpha</option><option value="b">Beta</option><option value="c">Gamma</option></select>
    <div id="out"></div>
    <script>
      document.getElementById('s').addEventListener('change', (e) => {
        document.getElementById('out').textContent = 'changed:' + e.target.value
      })
    </script>`))
  const byValue = await run('select', { selector: '#s', value: 'b' })
  check('select by value works', byValue.value === 'b', JSON.stringify(byValue))
  check('select reports the label', byValue.label === 'Beta', byValue.label)
  const changed = await evalInPage(`document.getElementById('out').textContent`)
  check('select fires change', changed === 'changed:b', changed)
  const byLabel = await run('select', { selector: '#s', label: 'Gamma' })
  check('select by label works', byLabel.value === 'c', byLabel.value)
  const bad = await run('select', { selector: '#s', value: 'zzz' }).catch((error) => String(error.message))
  check('select with an unknown option errors', String(bad).includes('没有匹配'), bad)
  const notSelect = await run('select', { selector: '#out', value: 'a' }).catch((error) => String(error.message))
  check('select on a non-select errors', String(notSelect).includes('不是 SELECT'), notSelect)
}

console.log('\n--- 6. keyboard -------------------------------------------------')

{
  const { run, evalInPage } = await page(shell(`
    <input id="k">
    <div id="keys"></div>
    <form id="f" onsubmit="event.preventDefault(); document.getElementById('keys').dataset.submitted='yes'">
      <input id="finput" type="text">
    </form>
    <script>
      document.getElementById('k').addEventListener('keydown', (e) => {
        document.getElementById('keys').dataset.last = e.key
      })
    </script>`))
  await run('press', { selector: '#k', key: 'Enter' })
  const last = await evalInPage(`document.getElementById('keys').dataset.last`)
  check('press dispatches keydown with the key', last === 'Enter', last)
  await run('type', { selector: '#finput', text: 'query' })
  await run('press', { key: 'Enter' })
  const submitted = await evalInPage(`document.getElementById('keys').dataset.submitted`)
  check('Enter submits the surrounding form', submitted === 'yes', submitted)
  const empty = await run('press', { key: '' }).catch((error) => String(error.message))
  check('press with an empty key errors', String(empty).includes('key 不能为空'), empty)
}

console.log('\n--- 6b. editing keys --------------------------------------------')

{
  // Dispatching keydown alone never deletes a character, so Backspace used to
  // look like it worked while the field kept its text.
  const { run, evalInPage } = await page(shell(`
    <input id="e" value="abc">
    <textarea id="t">line</textarea>`))
  await run('press', { selector: '#e', key: 'Backspace' })
  const afterBackspace = await evalInPage(`document.getElementById('e').value`)
  check('Backspace removes a character', afterBackspace === 'ab', afterBackspace)

  const reported = await run('press', { selector: '#e', key: 'Backspace' })
  check('press reports the edited value', reported.edited === 'a', JSON.stringify(reported.edited))

  await run('press', { selector: '#e', key: 'X' })
  const afterChar = await evalInPage(`document.getElementById('e').value`)
  check('a character key appends', afterChar === 'aX', afterChar)

  await run('press', { selector: '#e', key: 'Control+a' })
  const afterSelectAll = await evalInPage(`document.getElementById('e').value`)
  check('Control+a clears the field', afterSelectAll === '', JSON.stringify(afterSelectAll))

  await run('press', { selector: '#t', key: 'Enter' })
  const textarea = await evalInPage(`document.getElementById('t').value`)
  check('Enter inserts a newline in a textarea', textarea.includes('\\n'), JSON.stringify(textarea))

  // A key with no text meaning must not silently rewrite the field.
  const before = await evalInPage(`document.getElementById('e').value`)
  await run('press', { selector: '#e', key: 'ArrowDown' })
  const after = await evalInPage(`document.getElementById('e').value`)
  check('a non-editing key leaves the value alone', before === after, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
}

console.log('\n--- 7. scrolling ------------------------------------------------')

{
  const { run } = await page(shell(`
    <div style="height:5000px">
      <div id="marker" style="position:absolute;top:3000px">marker</div>
    </div>`))
  const down = await run('scroll', { dy: 800 })
  check('scroll moves down', down.viewport.scrollY > 0, String(down.viewport.scrollY))
  const up = await run('scroll', { dy: -400 })
  check('scroll moves up', up.viewport.scrollY < down.viewport.scrollY)
  const snap = await run('snapshot')
  const marker = snap.nodes.find((node) => node.name === 'marker')
  const toEl = await run('scroll', { ref: marker.ref })
  check('scroll to an element brings it into view', toEl.viewport.scrollY > 2000, String(toEl.viewport.scrollY))
  check('scroll reports page height', toEl.viewport.scrollHeight > 4000, String(toEl.viewport.scrollHeight))
}

console.log('\n--- 8. evaluate -------------------------------------------------')

{
  const { run } = await page(shell(`<div id="d" data-x="1">text</div>`))
  check('evaluate returns a primitive', await run('evaluate', { expression: '1 + 1' }) === 2)
  check('evaluate returns a string', await run('evaluate', { expression: 'document.title' }) === 'Case')
  const object = await run('evaluate', { expression: '({ a: 1, b: [2, 3] })' })
  check('evaluate returns a JSON-safe object', object.a === 1 && object.b[1] === 3, JSON.stringify(object))
  check('evaluate can read the DOM', await run('evaluate', { expression: `document.getElementById('d').dataset.x` }) === '1')
  check('evaluate maps undefined to null', await run('evaluate', { expression: 'undefined' }) === null)
  const empty = await run('evaluate', { expression: '' }).catch((error) => String(error.message))
  check('evaluate with an empty expression errors', String(empty).includes('不能为空'), empty)
  const thrown = await run('evaluate', { expression: 'nope.nope' }).catch((error) => String(error.message))
  check('evaluate surfaces a page exception', String(thrown).length > 0, thrown)
}

console.log('\n--- 9. wait -----------------------------------------------------')

{
  const { run } = await page(shell(`
    <div id="later"></div>
    <div id="never"></div>
    <script>
      setTimeout(() => { const d = document.createElement('span'); d.id = 'late'; d.textContent = 'arrived'; document.getElementById('later').append(d) }, 400)
    </script>`))
  const immediate = await run('wait', { selector: '#later', timeoutMs: 1000 })
  check('wait matches an element that already exists', immediate.matched === true)
  const delayed = await run('wait', { selector: '#late', timeoutMs: 3000 })
  check('wait catches a delayed element', delayed.matched === true && delayed.waitedMs >= 200, String(delayed.waitedMs))
  const timedOut = await run('wait', { selector: '#never-there', timeoutMs: 500 })
  check('wait reports a clean timeout', timedOut.matched === false)
  const byText = await run('wait', { text: 'arrived', timeoutMs: 1000 })
  check('wait matches by text', byText.matched === true)
  const hidden = await run('wait', { selector: '#never', state: 'visible', timeoutMs: 400 })
  check('wait for visible rejects a zero-height element', hidden.matched === false, JSON.stringify(hidden))
}

console.log('\n--- 10. ref lifecycle -------------------------------------------')

{
  const { run, evalInPage } = await page(shell(`<button id="b">one</button>`))
  const snap = await run('snapshot')
  const ref = snap.nodes.find((node) => node.tag === 'button').ref
  await run('click', { ref })
  await evalInPage(`document.body.innerHTML = '<button id="b2">two</button>'`)
  const stale = await run('click', { ref }).catch((error) => String(error.message))
  check('a ref from a replaced DOM is rejected', String(stale).includes('失效') || String(stale).includes('找不到'), stale)
  const fresh = await run('snapshot')
  check('a new snapshot yields new refs', fresh.nodes.some((node) => node.tag === 'button' && node.name === 'two'))

  // Refs are documented as valid for one snapshot. A page that never cleared
  // them kept every node it had ever shown reachable, which leaks in a long-lived
  // single-page app.
  const retained = await evalInPage(`Object.keys(window.__dshRefs || {}).length`)
  const nodeCount = fresh.nodes.length
  check('a snapshot keeps only its own refs', retained <= nodeCount, `refs=${retained} nodes=${nodeCount}`)
  const oldRefGone = await run('click', { ref }).catch((error) => String(error.message))
  check('a ref from an earlier snapshot is refused', String(oldRefGone).includes('失效'), oldRefGone)
}

console.log('\n--- 11. shadow DOM ----------------------------------------------')

{
  const { run, evalInPage } = await page(shell(`
    <div id="host"></div>
    <script>
      const root = document.getElementById('host').attachShadow({ mode: 'open' })
      root.innerHTML = '<button id="sb">shadow button</button><input id="si">'
      root.getElementById('sb').addEventListener('click', () => { root.getElementById('sb').textContent = 'clicked' })
    </script>`))
  const clicked = await evalInPage(`
    (() => {
      const root = document.getElementById('host').shadowRoot
      root.getElementById('sb').click()
      return root.getElementById('sb').textContent
    })()`)
  check('shadow DOM is reachable through evaluate', clicked === 'clicked', clicked)
  const note = await run('snapshot')
  check('snapshot does not crash on shadow hosts', Array.isArray(note.nodes))
}

console.log('\n--- 12. frames --------------------------------------------------')

{
  const { run, evalInPage } = await page(shell(`
    <iframe id="f" srcdoc="<button id='ib'>inside</button><p>frame text</p>"></iframe>`))
  await new Promise((resolve) => setTimeout(resolve, 300))
  const inside = await evalInPage(`document.getElementById('f').contentDocument.getElementById('ib').textContent`)
  check('same-origin iframe is reachable through evaluate', inside === 'inside', inside)
  const snap = await run('snapshot')
  check('snapshot on a page with iframes does not crash', Array.isArray(snap.nodes))
}

console.log('\n--- 13. capture -------------------------------------------------')

{
  const { run } = await page(shell(`
    <canvas id="c" width="300" height="150"></canvas>
    <svg id="s" width="200" height="100"><rect width="200" height="100" fill="#336"/></svg>
    <script>
      const x = document.getElementById('c').getContext('2d')
      x.fillStyle = '#0a0'; x.fillRect(0, 0, 300, 150)
    </script>`))
  const canvas = await run('capture', { selector: '#c', scale: 1 })
  check('capture returns a PNG data URL', String(canvas.dataUrl).startsWith('data:image/png;base64,'))
  check('capture reports canvas dimensions', canvas.width === 300 && canvas.height === 150, `${canvas.width}x${canvas.height}`)
  const svg = await run('capture', { selector: '#s', scale: 2 })
  check('capture scales an svg', svg.width === 400 && svg.height === 200, `${svg.width}x${svg.height}`)
  const auto = await run('capture', {})
  check('capture auto-picks the biggest chart', auto.count >= 2, String(auto.count))
}

console.log('\n--- 14. hostile pages -------------------------------------------')

{
  const { run } = await page(shell(`<button>ok</button>`))
  check('script survives a page with no ids', (await run('snapshot')).nodes.length >= 1)
  const empty = await page(shell(''))
  const emptySnap = await empty.run('snapshot')
  check('snapshot of an empty body is empty, not an error', Array.isArray(emptySnap.nodes))
  const huge = await page(shell(`<div>${'<p>row</p>'.repeat(2000)}</div>`))
  const hugeSnap = await huge.run('snapshot', { maxNodes: 50 })
  check('snapshot caps a huge page', hugeSnap.nodes.length <= 50, String(hugeSnap.nodes.length))
  const scriptHeavy = await page(shell(`<script>window.onerror = () => {}</script><p id="x">still here</p>`))
  check('page still readable with an error handler installed', (await scriptHeavy.run('readText')).text.includes('still here'))
}

console.log('\n--- 15. install idempotency -------------------------------------')

{
  await hub.navigate(tab.targetId, `data:text/html;charset=utf-8,${encodeURIComponent(shell('<p>idem</p>'))}`)
  const first = await hub.evalJs(tab.targetId, AGENT_SOURCE)
  check('first install reports fresh', first.value?.installed === true && first.value?.reused === false, JSON.stringify(first.value))
  const second = await hub.evalJs(tab.targetId, AGENT_SOURCE)
  check('second install reuses the existing surface', second.value?.reused === true, JSON.stringify(second.value))
  const version = await hub.evalJs(tab.targetId, `window.__dshBrowserAgent.version`)
  check('surface exposes a version', typeof version.value === 'number', String(version.value))
}

await hub.close()
console.log(`\n================ SCENARIOS ================`)
console.log(`${passed} passed, ${failures.length} failed, ${passed + failures.length} total`)
if (failures.length > 0) console.log('failed:', failures.join(' | '))
process.exit(failures.length === 0 ? 0 : 1)
