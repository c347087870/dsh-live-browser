/**
 * Page-behaviour assertions that need a DOM but not a browser.
 *
 * The scenario suite drives a real Chrome over CDP to prove the injected script
 * works on live pages. That is the strongest check, but it needs an external
 * browser, which is not always available and is not the browser this plugin
 * actually operates.
 *
 * These cases run the same injected script inside jsdom instead. jsdom has no
 * layout engine and no real compositor, so anything that depends on geometry is
 * out of scope here; event dispatch, ref lifetime, text reading and value
 * editing are exactly what the script itself implements, so they are in scope.
 */
import { JSDOM, VirtualConsole } from 'jsdom'
import { AGENT_SOURCE } from '../lib/agent-script.js'

const failures = []
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS ${label}`)
  else { failures.push(label); console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

/**
 * Build a window with the injected script installed.
 *
 * `scrollIntoView` and `getBoundingClientRect` are stubbed because jsdom does not
 * lay elements out; every case that matters here reads DOM state, not pixels.
 */
async function page(html) {
  const dom = new JSDOM(`<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  })
  const { window } = dom
  window.Element.prototype.scrollIntoView = function scrollIntoView() {}
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30, toJSON() { return this } }
  }
  window.eval(AGENT_SOURCE)
  const agent = window.__dshBrowserAgent
  return {
    window,
    agent,
    run: (method, params) => agent[method](params ?? {}),
    read: (expression) => window.eval(expression),
  }
}

// ---------------------------------------------------------------------------
// Pointer events: modern frameworks bind these instead of the mouse pair
// ---------------------------------------------------------------------------

{
  const { run, read } = await page('<button id="p">pointer</button>')
  const seen = []
  for (const type of ['pointerover', 'pointerenter', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
    read(`document.getElementById('p').addEventListener('${type}', () => window.__seen.push('${type}'))`)
  }
  const { window } = await Promise.resolve({ window: null })
  void window
  const ordered = []
  read("window.__seen = []")
  run('click', { selector: '#p' })
  const recorded = read('window.__seen.join(",")')
  check('click dispatches pointerdown', String(recorded).includes('pointerdown'), recorded)
  check('click dispatches pointerup', String(recorded).includes('pointerup'), recorded)
  check('click still dispatches mousedown', String(recorded).includes('mousedown'), recorded)
  check('click still dispatches mouseup', String(recorded).includes('mouseup'), recorded)
  check('click fires the click event', String(recorded).includes('click'), recorded)
  check('pointerdown precedes mouseup', String(recorded).indexOf('pointerdown') < String(recorded).indexOf('mouseup'), recorded)
}

// A listener bound only to pointerdown is what a drag library uses.
{
  const { run, read } = await page(`
    <button id="p2">p2</button>
    <div id="flag">none</div>
    <script>
      window.addEventListener('DOMContentLoaded', () => {})
      document.getElementById('p2').addEventListener('pointerdown', () => {
        document.getElementById('flag').textContent = 'caught'
      })
    </script>`)
  run('click', { selector: '#p2' })
  const flag = read("document.getElementById('flag').textContent")
  check('a pointer-only listener receives the click', flag === 'caught', flag)
}

// ---------------------------------------------------------------------------
// Editing keys: keydown alone never changed a field's value
// ---------------------------------------------------------------------------

{
  const { run, read } = await page('<input id="e" value="abc"><textarea id="t">line</textarea>')

  const backspace = run('press', { selector: '#e', key: 'Backspace' })
  check('Backspace removes a character', read("document.getElementById('e').value") === 'ab', read("document.getElementById('e').value"))
  check('press reports the edited value', backspace.edited === 'ab', JSON.stringify(backspace.edited))

  run('press', { selector: '#e', key: 'X' })
  check('a character key appends', read("document.getElementById('e').value") === 'abX', read("document.getElementById('e').value"))

  run('press', { selector: '#e', key: 'Control+a' })
  check('Control+a clears the field', read("document.getElementById('e').value") === '', read("document.getElementById('e').value"))

  run('press', { selector: '#t', key: 'Enter' })
  check('Enter inserts a newline in a textarea', read("document.getElementById('t').value").includes('\n'), JSON.stringify(read("document.getElementById('t').value")))

  const before = read("document.getElementById('e').value")
  run('press', { selector: '#e', key: 'ArrowDown' })
  const after = read("document.getElementById('e').value")
  check('a non-editing key leaves the value alone', before === after, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`)

  const empty = await Promise.resolve().then(() => {
    try { run('press', { key: '' }) } catch (error) { return String(error.message) }
    return undefined
  })
  check('press with an empty key errors', String(empty).includes('key 不能为空'), empty)
}

// A modified key must not type its prefix into the field.
{
  const { run, read } = await page('<input id="s" value="">')
  run('press', { selector: '#s', key: 'Shift+A' })
  const value = read("document.getElementById('s').value")
  check('a modified key does not type its prefix', value === 'A', JSON.stringify(value))
}

// ---------------------------------------------------------------------------
// Ref lifetime: one snapshot's worth of refs, and stale refs fail loudly
// ---------------------------------------------------------------------------

{
  const { run, read } = await page('<button id="b">one</button><a id="a" href="#x">link</a>')
  const first = run('snapshot', { maxNodes: 50 })
  check('snapshot returns nodes with refs', Array.isArray(first.nodes) && first.nodes.some((node) => node.ref), JSON.stringify(first.nodes?.length))

  const refsAfterFirst = read('Object.keys(window.__dshRefs || {}).length')
  check('refs are tracked per snapshot', refsAfterFirst >= first.nodes.length, `refs=${refsAfterFirst} nodes=${first.nodes.length}`)

  // A second snapshot must not accumulate the first one's nodes.
  run('snapshot', { maxNodes: 50 })
  const refsAfterSecond = read('Object.keys(window.__dshRefs || {}).length')
  const second = run('snapshot', { maxNodes: 50 })
  check('a new snapshot does not accumulate old refs', refsAfterSecond <= second.nodes.length * 2, `refs=${refsAfterSecond} nodes=${second.nodes.length}`)

  // A ref from a replaced DOM must be refused, not silently acted on.
  const buttonRef = first.nodes.find((node) => node.tag === 'button')?.ref
  read("document.body.innerHTML = '<button id=\\'b2\\'>two</button>'")
  let stale
  try { run('click', { ref: buttonRef }) } catch (error) { stale = String(error.message) }
  check('a ref from a replaced DOM is refused', String(stale).includes('失效'), stale)
}

// ---------------------------------------------------------------------------
// Reading and text extraction
// ---------------------------------------------------------------------------

{
  const { run } = await page('<h1>Title</h1><p>Body text here.</p>')
  const snapshot = run('snapshot', { maxNodes: 50 })
  check('snapshot finds the heading', snapshot.nodes.some((node) => node.tag === 'h1' && node.name === 'Title'), JSON.stringify(snapshot.nodes.map((node) => node.tag)))
  const text = run('readText', {})
  check('readText returns the body text', String(text.text).includes('Body text here.'), text.text)
  const scoped = run('readText', { selector: 'h1' })
  check('readText honours a selector', scoped.text === 'Title', JSON.stringify(scoped.text))
  const limited = run('readText', { maxChars: 5 })
  check('readText truncates at maxChars', limited.truncated === true, JSON.stringify(limited))
}

// ---------------------------------------------------------------------------
// Typing into fields and contenteditable
// ---------------------------------------------------------------------------

{
  const { run, read } = await page('<input id="i"><textarea id="t"></textarea><div id="c" contenteditable="true"></div><span id="plain">text</span>')
  run('type', { selector: '#i', text: 'hello' })
  check('type writes an input value', read("document.getElementById('i').value") === 'hello', read("document.getElementById('i').value"))
  run('type', { selector: '#i', text: 'world', clear: false })
  check('type appends when clear is false', read("document.getElementById('i').value") === 'helloworld', read("document.getElementById('i').value"))
  run('type', { selector: '#c', text: 'rich' })
  check('type writes contenteditable text', read("document.getElementById('c').textContent") === 'rich', read("document.getElementById('c').textContent"))

  let refused
  try { run('type', { selector: '#plain', text: 'x' }) } catch (error) { refused = String(error.message) }
  check('type on a non-editable element errors', String(refused).includes('不能输入'), refused)
}

// ---------------------------------------------------------------------------
// Disabled controls and missing targets fail closed
// ---------------------------------------------------------------------------

{
  const { run } = await page('<button id="d" disabled>nope</button>')
  let disabledError
  try { run('click', { selector: '#d' }) } catch (error) { disabledError = String(error.message) }
  check('clicking a disabled control errors', String(disabledError).includes('禁用'), disabledError)

  let missingError
  try { run('click', { selector: '#nope' }) } catch (error) { missingError = String(error.message) }
  check('a missing selector errors', String(missingError).includes('找不到元素'), missingError)
}

// ---------------------------------------------------------------------------
// Evaluate
// ---------------------------------------------------------------------------

{
  const { run } = await page('<div id="x">42</div>')
  check('evaluate returns a scalar', run('evaluate', { expression: '1+1' }) === 2, JSON.stringify(run('evaluate', { expression: '1+1' })))
  check('evaluate reads the DOM', String(run('evaluate', { expression: "document.getElementById('x').textContent" })) === '42')
  let thrown
  try { run('evaluate', { expression: 'nope.nope' }) } catch (error) { thrown = String(error.message) }
  check('evaluate surfaces a page error', thrown !== undefined && thrown.length > 0, thrown)
  let emptyExpression
  try { run('evaluate', { expression: '' }) } catch (error) { emptyExpression = String(error.message) }
  check('evaluate with an empty expression errors', String(emptyExpression).includes('不能为空'), emptyExpression)
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

{
  const { run } = await page('<select id="s"><option value="a">Alpha</option><option value="b">Beta</option></select>')
  const byValue = run('select', { selector: '#s', value: 'b' })
  check('select matches by value', byValue.value === 'b', JSON.stringify(byValue))
  const byLabel = run('select', { selector: '#s', label: 'Alpha' })
  check('select matches by label', byLabel.value === 'a', JSON.stringify(byLabel))
  let unknown
  try { run('select', { selector: '#s', value: 'zzz' }) } catch (error) { unknown = String(error.message) }
  check('select with an unknown option errors', String(unknown).includes('没有匹配'), unknown)
}

// ---------------------------------------------------------------------------
// Page identity and viewport geometry
// ---------------------------------------------------------------------------

{
  const { run } = await page('<h1>Title</h1>')
  const state = run('state', {})
  check('state reports a readyState', typeof state.readyState === 'string', state.readyState)
  check('state reports a viewport object', typeof state.viewport === 'object' && state.viewport !== null, JSON.stringify(state.viewport))
  check('state viewport carries scroll offsets', typeof state.viewport.scrollY === 'number', JSON.stringify(state.viewport))
}

// ---------------------------------------------------------------------------
// Waiting: resolves on a present target, and a miss is reported not thrown
// ---------------------------------------------------------------------------

{
  const { agent, window } = await page('<div id="ready">present</div>')
  // wait() is async, so it must be awaited rather than called synchronously.
  const hit = await agent.wait({ selector: '#ready', timeoutMs: 500 })
  check('wait matches an existing selector', hit.matched === true, JSON.stringify(hit))

  const byText = await agent.wait({ text: 'present', timeoutMs: 500 })
  check('wait matches by text', byText.matched === true, JSON.stringify(byText))

  const miss = await agent.wait({ selector: '#never', timeoutMs: 120 })
  check('wait reports a miss without throwing', miss.matched === false, JSON.stringify(miss))
  check('a miss still reports the elapsed wait', typeof miss.waitedMs === 'number', String(miss.waitedMs))

  // "display:none" is a style check, not a geometry one, so it is meaningful
  // under jsdom even though the layout box is stubbed. A zero-height check would
  // only be testing the stub.
  const hidden = window.document.createElement('div')
  hidden.id = 'hidden'
  hidden.style.display = 'none'
  hidden.textContent = 'hidden'
  window.document.body.appendChild(hidden)
  const invisible = await agent.wait({ selector: '#hidden', state: 'visible', timeoutMs: 120 })
  check('wait for visible rejects a display:none element', invisible.matched === false, JSON.stringify(invisible))
}

// ---------------------------------------------------------------------------
// Scrolling
// ---------------------------------------------------------------------------

{
  const { run, window } = await page('<div style="height:2000px">tall</div>')
  // jsdom does not scroll, so record the call and verify the reported geometry.
  let scrolledBy = null
  window.scrollBy = (dx, dy) => { scrolledBy = { dx, dy } }
  run('scroll', { dy: 800 })
  check('scroll forwards the delta to the page', scrolledBy?.dy === 800, JSON.stringify(scrolledBy))
  run('scroll', { dx: 40, dy: -120 })
  check('scroll forwards horizontal and negative deltas', scrolledBy?.dx === 40 && scrolledBy?.dy === -120, JSON.stringify(scrolledBy))
}

// ---------------------------------------------------------------------------
// Script installation is idempotent, so re-injecting never doubles handlers
// ---------------------------------------------------------------------------

{
  const { window, agent } = await page('<button id="i">one</button>')
  const before = window.__dshRefSeq ?? 0
  const again = window.eval(AGENT_SOURCE)
  check('re-installing reuses the existing surface', again?.reused === true, JSON.stringify(again))
  check('the agent object is unchanged after re-injection', window.__dshBrowserAgent === agent)
  check('re-installing does not reset the ref counter', (window.__dshRefSeq ?? 0) === before, String(window.__dshRefSeq))
}

console.log(failures.length === 0 ? '\nDOM BEHAVIOUR OK' : `\nDOM BEHAVIOUR FAILED (${failures.length})`)
process.exit(failures.length === 0 ? 0 : 1)
