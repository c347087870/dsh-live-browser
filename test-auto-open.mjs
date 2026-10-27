/**
 * Auto-open contract.
 *
 * The sidebar browser lives entirely in the renderer, so the host cannot create
 * the tab. What makes auto-open work is this split:
 *
 *   - the CLIENT bundle polls continuously, even before any browser tab exists;
 *   - when a queued command arrives and no guest is mounted, the client opens
 *     the sidebar browser itself and then runs the command;
 *   - the HOST simply keeps the command queued long enough for that round trip.
 *
 * So the host-side guarantees under test are: a command queued from cold stays
 * available for a late-arriving panel, and it fails only with an actionable
 * message. The client-side readiness logic is covered by test-client-driver.mjs.
 */
import { BrowserBridge } from './lib/bridge.js'
import { normalizeAddress } from './lib/tools.js'

const failures = []
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS ${label}`)
  else { failures.push(label); console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

console.log('\n--- address normalisation --------------------------------------')
check('bare host gains https', normalizeAddress('example.com') === 'https://example.com', normalizeAddress('example.com'))
check('explicit scheme is preserved', normalizeAddress('http://a.test/x') === 'http://a.test/x')
check('localhost keeps http', normalizeAddress('localhost:5173') === 'http://localhost:5173', normalizeAddress('localhost:5173'))
check('an IP keeps http', normalizeAddress('127.0.0.1:8080') === 'http://127.0.0.1:8080')
check('blank input yields nothing', normalizeAddress('   ') === undefined)
check('mailto is passed through', normalizeAddress('mailto:a@b.test') === 'mailto:a@b.test')
check('a path-only input becomes https', normalizeAddress('a.test/x?y=1') === 'https://a.test/x?y=1')

console.log('\n--- a cold call survives a late panel --------------------------')

{
  const bridge = new BrowserBridge({ timeoutMs: 5000 })
  // A tool call arrives before anything is polling, which is the cold-start case.
  const pending = bridge.call('navigate', { url: 'https://a.test' }, { panelWaitMs: 3000 })

  // The client bundle would be polling already; simulate its arrival mid-wait.
  await new Promise((resolve) => setTimeout(resolve, 250))
  const command = bridge.poll('panel-late')
  check('the command is still queued for the late panel', command !== null, JSON.stringify(command))
  check('the queued command kept its payload', command?.params?.url === 'https://a.test', JSON.stringify(command?.params))
  bridge.settle('panel-late', command.id, { ok: true, value: { url: 'https://a.test' } })
  const result = await pending
  check('the cold call resolves once the panel arrives', result.url === 'https://a.test', JSON.stringify(result))
  bridge.close()
}

console.log('\n--- failing closed ---------------------------------------------')

{
  const bridge = new BrowserBridge({ timeoutMs: 1000 })
  let error
  try {
    await bridge.call('navigate', { url: 'https://a.test' }, { panelWaitMs: 80 })
  } catch (failure) {
    error = failure
  }
  check('with no panel the call fails', error?.code === 'PANEL_NOT_OPEN', error?.code)
  check('the message points at the DSH sidebar', String(error?.message).includes('右侧栏'), error?.message)
  check('a failed call leaves no queued command', bridge.poll('p1') === null)
  bridge.close()
}

console.log('\n--- a warm panel is used immediately ---------------------------')

{
  const bridge = new BrowserBridge({ timeoutMs: 5000 })
  bridge.poll('panel-warm')
  check('a poll attaches the panel', bridge.attached === true)
  const pending = bridge.call('state', {}, {})
  const command = bridge.poll('panel-warm')
  check('the command is handed over at once', command?.method === 'state', JSON.stringify(command?.method))
  bridge.settle('panel-warm', command.id, { ok: true, value: { url: 'about:blank' } })
  const value = await pending
  check('the warm call resolves', value.url === 'about:blank', JSON.stringify(value))
  bridge.close()
}

console.log('\n--- a stalled panel times out cleanly --------------------------')

{
  const bridge = new BrowserBridge({ timeoutMs: 400 })
  bridge.poll('panel-stall')
  const pending = bridge.call('state', {}, { timeoutMs: 400 })
  const command = bridge.poll('panel-stall')
  check('the command was picked up', command !== null)
  // The bridge unrefs its timer so it never holds the process open; keep a real
  // timer alive here so this test can actually observe the timeout.
  const keepAlive = setTimeout(() => {}, 1500)
  let error
  try {
    await pending
  } catch (failure) {
    error = failure
  } finally {
    clearTimeout(keepAlive)
  }
  check('an unanswered command times out', error?.code === 'TIMEOUT', error?.code)
  check('the timeout names the method', String(error?.message).includes('state'), error?.message)
  // A late answer must not crash the bridge.
  bridge.settle('panel-stall', command.id, { ok: true, value: {} })
  check('a late answer is ignored quietly', true)
  bridge.close()
}

console.log('\n--- parallel calls keep their own results ----------------------')

{
  const bridge = new BrowserBridge({ timeoutMs: 5000 })
  bridge.poll('panel-p')
  const first = bridge.call('snapshot', { tag: 'first' }, {})
  const second = bridge.call('readText', { tag: 'second' }, {})
  const a = bridge.poll('panel-p')
  const b = bridge.poll('panel-p')
  check('both commands were queued', a !== null && b !== null)
  check('they are distinct methods', a.method !== b.method, `${a?.method}/${b?.method}`)
  // Answer them out of order to prove results are matched by id.
  bridge.settle('panel-p', b.id, { ok: true, value: { which: 'second' } })
  bridge.settle('panel-p', a.id, { ok: true, value: { which: 'first' } })
  const [firstValue, secondValue] = await Promise.all([first, second])
  check('results are matched by command id', firstValue.which === 'first' && secondValue.which === 'second', JSON.stringify([firstValue, secondValue]))
  bridge.close()
}

console.log(failures.length === 0 ? '\nAUTO-OPEN OK' : `\nAUTO-OPEN FAILED (${failures.length})`)
process.exit(failures.length === 0 ? 0 : 1)
