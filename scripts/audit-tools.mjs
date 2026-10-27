/**
 * Audit the tool -> method -> handler chain.
 *
 * Every tool queues a method name; the client must dispatch it. A tool whose
 * method has no handler is a tool that always fails, which is fatal for a
 * marketplace release. This reports the full matrix.
 */
import { readFileSync } from 'node:fs'
import { browserToolNames } from '../lib/tools.js'
import { AGENT_SOURCE } from '../lib/agent-script.js'

const tools = readFileSync('lib/tools.js', 'utf8')
const client = readFileSync('client.js', 'utf8')

/** Methods each tool calls, read straight out of the tool source. */
const calls = new Map()
const registerBlocks = tools.split("register({").slice(1)
for (const block of registerBlocks) {
  const nameMatch = /name:\s*'([a-zA-Z_]+)'/.exec(block)
  if (nameMatch === null) continue
  const methods = [...block.matchAll(/run\('([a-zA-Z]+)'/g)].map((m) => m[1])
  calls.set(nameMatch[1], methods)
}

/** Handlers the client forwards to the host rather than the page. */
const hostForwarded = new Set(['tabNew'])
/** Handlers the client implements directly. */
const browserLevel = new Set(['navigate', 'tabs', 'state', 'back', 'forward', 'reload'])
/** Handlers the injected page script exposes. */
const pageLevel = new Set(
  [...AGENT_SOURCE.matchAll(/^\s{4}(?:async )?([a-zA-Z]+)\(params\)/gm)].map((m) => m[1]),
)
/** Extra aliases the client maps to a guest element method. */
const aliased = new Set(['back', 'forward', 'reload'])

console.log('page-script methods :', [...pageLevel].join(', '))
console.log('browser-level       :', [...browserLevel].join(', '))
console.log('')

const broken = []
for (const [tool, methods] of calls) {
  if (methods.length === 0) continue
  for (const method of methods) {
    const ok = browserLevel.has(method) || pageLevel.has(method) || aliased.has(method) || hostForwarded.has(method)
    if (!ok) broken.push({ tool, method })
  }
}

if (broken.length === 0) {
  console.log('all tool methods have a handler')
} else {
  console.log('TOOLS WHOSE METHOD HAS NO HANDLER:')
  for (const entry of broken) console.log(`  ${entry.tool} -> ${entry.method}()`)
}

// Tools that call no method at all (they only compose other tools or throw).
const noCall = [...calls].filter(([, methods]) => methods.length === 0).map(([tool]) => tool)
console.log('\ntools with no queued command:', noCall.join(', ') || '(none)')

// The CLI surface: does the doc list match reality?
const listed = browserToolNames()
const registered = [...calls.keys()]
const missing = listed.filter((name) => !registered.includes(name))
const extra = registered.filter((name) => !listed.includes(name))
console.log('declared but not registered:', missing.join(', ') || '(none)')
console.log('registered but not declared:', extra.join(', ') || '(none)')

console.log(`\nsummary: ${registered.length} registered, ${broken.length} broken method(s)`)
process.exit(broken.length === 0 ? 0 : 1)
