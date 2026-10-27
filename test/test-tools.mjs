/**
 * Tool-layer check: the agent-facing surface registers cleanly, advertises the
 * expected parameter shapes, and reports PANEL_NOT_OPEN instead of hanging when
 * the sidebar browser was never opened.
 */
import { BrowserBridge } from '../lib/bridge.js'
import { registerBrowserTools, browserToolNames } from '../lib/tools.js'
import { handleEndpoint } from '../lib/rpc.js'

const failures = []
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS ${label}`)
  else { failures.push(label); console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

const tools = []
const ctx = {
  logger: { info() {}, warn: console.warn, debug() {} },
  tools: { register: (definition) => tools.push(definition) },
  get: () => undefined,
}

const bridge = new BrowserBridge({ timeoutMs: 500 })
registerBrowserTools(ctx, { confirmSensitive: true }, bridge)

check('25 tools registered', tools.length === 25, `got ${tools.length}`)
check('names match browserToolNames()', JSON.stringify(tools.map((tool) => tool.name)) === JSON.stringify(browserToolNames()))
check('every tool has a description', tools.every((tool) => typeof tool.description === 'string' && tool.description.trim().length >= 5))
check('every tool has an object schema', tools.every((tool) => tool.parameters?.type === 'object'))
check('every tool has an output renderer', tools.every((tool) => typeof tool.output?.render === 'function'))

const byName = new Map(tools.map((tool) => [tool.name, tool]))
check('click accepts ref/selector/coordinates', ['ref', 'selector', 'x', 'y'].every((key) => key in byName.get('browser_click').parameters.properties))
check('click accepts sensitive', 'sensitive' in byName.get('browser_click').parameters.properties)
check('type requires text', byName.get('browser_type').parameters.required?.includes('text') === true)
check('navigate requires url', byName.get('browser_navigate').parameters.required?.includes('url') === true)
check('wait exposes timeout', 'timeoutMs' in byName.get('browser_wait').parameters.properties)

// Calling a tool with no panel must fail fast and explain what to do.
const status = await byName.get('browser_status').execute({}, {})
check('browser_status reports detached', status.attached === false, JSON.stringify(status))
check('browser_status tells the user how to open it', String(status.hint).includes('\u53f3\u4fa7\u680f'), status.hint)

let navigationError
try {
  await byName.get('browser_navigate').execute({ url: 'example.com' }, {})
} catch (error) {
  navigationError = String(error?.message ?? error)
}
check('navigate without a panel explains itself', String(navigationError).includes('\u6ca1\u80fd\u6253\u5f00'), String(navigationError).slice(0, 80))
check('navigate error is actionable', navigationError !== undefined, navigationError)

// A sensitive click with no confirmation channel must be refused, not executed.
const sensitive = await byName.get('browser_click').execute({ ref: 'e1', sensitive: true }, {})
check('sensitive action refused without a channel', sensitive.executed === false, JSON.stringify(sensitive))

// The RPC surface answers the panel endpoints.
const panelSource = await handleEndpoint(bridge, 'source', {})
check('source endpoint returns the agent script', typeof panelSource.value?.source === 'string' && panelSource.value.source.length > 1000, String(panelSource.value?.bytes))
check('source script parses', (() => {
  try { new Function(panelSource.value.source); return true } catch { return false }
})())
const statusEndpoint = await handleEndpoint(bridge, 'status', {})
check('status endpoint works', statusEndpoint.ok === true && statusEndpoint.value.attached === false)
const unknown = await handleEndpoint(bridge, 'nope', {})
check('unknown endpoint is a clean protocol error', unknown.ok === false)

bridge.close()
console.log(failures.length === 0 ? '\nTOOL LAYER OK' : `\nTOOL LAYER FAILED (${failures.length})`)
process.exit(failures.length === 0 ? 0 : 1)
