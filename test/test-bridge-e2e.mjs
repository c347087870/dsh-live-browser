/**
 * 端到端链路检查，不需要任何浏览器：
 *
 *   工具调用 → 桥接队列 → 模拟面板取走 → 页面执行 → settle → 工具结果
 *
 * 「面板」在这里是一个替身，用的是真实注入脚本，跑在 jsdom 里而不是真 Chrome。
 * 除了把 DSH 的 <webview> 换成测试替身，这条链路上的每一环都是发布版代码。
 */
import { JSDOM, VirtualConsole } from 'jsdom'
import { BrowserBridge } from '../lib/bridge.js'
import { AGENT_SOURCE } from '../lib/agent-script.js'

const failures = []
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS ${label}`)
  else { failures.push(label); console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

/** 建一个装好注入脚本的页面，充当侧边栏里的那个 guest。 */
function createPage() {
  const dom = new JSDOM(
    `<!doctype html><html><head><title>Bridge 测试页</title></head><body>
      <h1>Bridge 测试页</h1>
      <input id="q" type="text" placeholder="search" />
      <button id="go">Go</button>
      <div id="out">idle</div>
    </body></html>`,
    { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: new VirtualConsole() },
  )
  const { window } = dom
  // jsdom 没有排版引擎，这两个 API 必须打桩，脚本才能跑起来。
  window.Element.prototype.scrollIntoView = function scrollIntoView() {}
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30, toJSON() { return this } }
  }
  // 页面自己的处理器：证明事件是真的送达了页面，而不是被脚本伪造结果。
  window.document.getElementById('go').addEventListener('click', () => {
    const value = window.document.getElementById('q').value || ''
    window.document.getElementById('out').textContent = `ran:${value}`
  })
  window.eval(AGENT_SOURCE)
  return window
}

/**
 * 在页面里执行一条命令，返回注入脚本自己的结果。
 *
 * 和发布版面板的做法一致：把脚本和参数拼成表达式交给页面求值。
 */
async function runOnPage(window, method, params) {
  const expression = `(async () => { ${AGENT_SOURCE}; return await window.__dshBrowserAgent[${JSON.stringify(method)}](${JSON.stringify(params)}); })()`
  try {
    return { ok: true, value: window.eval(expression) }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

const bridge = new BrowserBridge({ timeoutMs: 5000 })
const window = createPage()

/** 模拟面板：取走一条命令，在页面上执行，把结果 settle 回去。 */
async function panelOnce(panelId = 'test-panel') {
  const command = bridge.poll(panelId)
  if (command === null) return undefined
  const outcome = await runOnPage(window, command.method, command.params ?? {})
  bridge.settle(panelId, command.id, outcome.ok ? { ok: true, value: outcome.value } : { ok: false, error: outcome.error })
  return outcome.ok ? outcome.value : Promise.reject(new Error(outcome.error))
}

/** 发起一次工具级调用，并反复驱动面板直到它有结果。 */
async function viaBridge(method, params) {
  const pending = bridge.call(method, params, { panelWaitMs: 0 })
  const settled = pending.catch((error) => ({ __error: error }))
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await panelOnce().catch(() => {})
    const raced = await Promise.race([
      settled,
      new Promise((resolve) => setTimeout(() => resolve(undefined), 20)),
    ])
    if (raced !== undefined) {
      if (raced && raced.__error) throw raced.__error
      return raced
    }
  }
  return settled
}

// 1. 面板第一次轮询后就应当被视为已连接。
bridge.poll('test-panel')
check('面板轮询一次后即视为已连接', bridge.attached === true)
check('桥接能列出正在轮询的面板', bridge.panels().length === 1)

// 2. 页面命令能完整走完队列。
const state = await viaBridge('state', {})
check('state 经桥接往返正常', String(state.title).includes('Bridge'), state.title)

// 3. 先输入再点击，用页面自己的处理器证明事件真的到位。
const snapshot = await viaBridge('snapshot', {})
const input = snapshot.nodes.find((node) => node.tag === 'input')
const button = snapshot.nodes.find((node) => node.tag === 'button')
check('经桥接拿到的快照里有输入框', input !== undefined)
check('经桥接拿到的快照里有按钮', button?.name === 'Go', button?.name)

const typed = await viaBridge('type', { ref: input.ref, text: 'deepseek' })
check('type 经桥接写入输入框', typed.value === 'deepseek', JSON.stringify(typed))

await viaBridge('click', { ref: button.ref })
const out = await viaBridge('readText', { selector: '#out' })
check('click 经桥接触发了页面自己的处理器', out.text.includes('ran:deepseek'), out.text)

// 4. 失败的命令要把错误明确交回调用方，而不是挂住。
let failure
try {
  await viaBridge('type', { ref: 'e999999', text: 'x' })
} catch (error) {
  failure = String(error?.message ?? error)
}
check('页面错误能传回调用方', String(failure).includes('快照引用已失效'), failure)

// 5. 没有任何面板轮询时，调用要立刻失败并给出可操作的提示。
const other = new BrowserBridge({ timeoutMs: 3000 })
let noPanel
try {
  await other.call('state', {}, { panelWaitMs: 0 })
} catch (error) {
  noPanel = { code: error.code, message: error.message }
}
check('没有面板时返回 PANEL_NOT_OPEN', noPanel?.code === 'PANEL_NOT_OPEN', JSON.stringify(noPanel))
check('提示会告诉用户该怎么做', String(noPanel?.message).includes('右侧栏'), noPanel?.message)

bridge.close()
other.close()
console.log(failures.length === 0 ? '\nBRIDGE END-TO-END OK' : `\nBRIDGE END-TO-END FAILED (${failures.length})`)
process.exit(failures.length === 0 ? 0 : 1)
