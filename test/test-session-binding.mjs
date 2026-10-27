/**
 * Session binding: a browser command must stay in the chat that asked for it.
 *
 * The bug this locks down: start a request in chat A, switch to chat B before
 * the browser opens, and the browser used to appear in B. DSH keeps one sidebar
 * per Session, so the fix is to carry the originating Session id on every
 * command and only hand it to a panel rendering that same Session.
 */
import { BrowserBridge } from '../lib/bridge.js'

const failures = []
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS ${label}`)
  else { failures.push(label); console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

const settleOk = (bridge, panelId, command, value = { ok: true }) => {
  bridge.settle(panelId, command.id, { ok: true, value })
}

console.log('\n--- a command only reaches its own conversation ----------------')

{
  const bridge = new BrowserBridge({ timeoutMs: 4000 })
  // Two chats are open, each with a sidebar polling.
  bridge.poll('panel-A', 'session-A')
  bridge.poll('panel-B', 'session-B')

  const pending = bridge.call('navigate', { url: 'https://a.test' }, { sessionId: 'session-A' })

  // Chat B polls first. It must NOT receive chat A's command.
  const stolenByB = bridge.poll('panel-B', 'session-B')
  check('another conversation cannot take the command', stolenByB === null, JSON.stringify(stolenByB))

  const forA = bridge.poll('panel-A', 'session-A')
  check('the owning conversation receives it', forA?.method === 'navigate', JSON.stringify(forA?.method))
  check('the command reports its conversation', forA?.sessionId === 'session-A', JSON.stringify(forA?.sessionId))
  settleOk(bridge, 'panel-A', forA)
  await pending
  bridge.close()
}

console.log('\n--- the wrong chat is never satisfied by another panel --------')

{
  const bridge = new BrowserBridge({ timeoutMs: 800 })
  // Only chat A has a panel; the caller is chat B.
  bridge.poll('panel-A', 'session-A')
  let error
  try {
    await bridge.call('snapshot', {}, { sessionId: 'session-B', panelWaitMs: 120 })
  } catch (failure) {
    error = failure
  }
  check('a request from an unattached conversation fails', error?.code === 'PANEL_NOT_OPEN', error?.code)
  check('the message tells the user not to switch chats', String(error?.message).includes('当前对话'), error?.message)
  bridge.close()
}

console.log('\n--- attachedTo is per conversation ----------------------------')

{
  const bridge = new BrowserBridge({ timeoutMs: 2000 })
  bridge.poll('panel-A', 'session-A')
  check('the attached chat is recognised', bridge.attachedTo('session-A') === true)
  check('an unrelated chat is not attached', bridge.attachedTo('session-B') === false)
  check('without a session the bridge reports any panel', bridge.attachedTo(undefined) === true)
  bridge.close()
}

console.log('\n--- a session-less caller still works -------------------------')

{
  const bridge = new BrowserBridge({ timeoutMs: 3000 })
  bridge.poll('panel-A', 'session-A')
  // Tools invoked outside a chat (or on an older host) omit the session.
  const pending = bridge.call('state', {}, {})
  const command = bridge.poll('panel-A', 'session-A')
  check('an unbound command is claimable', command?.method === 'state', JSON.stringify(command?.method))
  check('it carries no session field', command?.sessionId === undefined, JSON.stringify(command?.sessionId))
  settleOk(bridge, 'panel-A', command)
  await pending
  bridge.close()
}

console.log('\n--- queued commands keep their own binding --------------------')

{
  const bridge = new BrowserBridge({ timeoutMs: 3000 })
  bridge.poll('panel-A', 'session-A')
  bridge.poll('panel-B', 'session-B')

  const first = bridge.call('readText', { tag: 'A' }, { sessionId: 'session-A' })
  const second = bridge.call('readText', { tag: 'B' }, { sessionId: 'session-B' })

  const forB = bridge.poll('panel-B', 'session-B')
  check('B gets its own command, not A\'s', forB?.sessionId === 'session-B', JSON.stringify(forB?.sessionId))
  const forA = bridge.poll('panel-A', 'session-A')
  check('A gets its own command', forA?.sessionId === 'session-A', JSON.stringify(forA?.sessionId))

  settleOk(bridge, 'panel-B', forB, { tag: 'B' })
  settleOk(bridge, 'panel-A', forA, { tag: 'A' })
  const [aValue, bValue] = await Promise.all([first, second])
  check('each conversation got its own result', aValue.tag === 'A' && bValue.tag === 'B', JSON.stringify([aValue, bValue]))
  bridge.close()
}

console.log('\n--- switching chats mid-request keeps the binding -------------')

{
  const bridge = new BrowserBridge({ timeoutMs: 3000 })
  // Chat A asks for a page while A is on screen.
  const pending = bridge.call('navigate', { url: 'https://a.test' }, { sessionId: 'session-A', panelWaitMs: 600 })

  // The user switches to chat B before A's panel has polled.
  bridge.poll('panel-B', 'session-B')
  const takenByB = bridge.poll('panel-B', 'session-B')
  check('the switched-to chat does not receive the command', takenByB === null, JSON.stringify(takenByB))

  // Chat A's sidebar comes up afterwards and takes it.
  const forA = bridge.poll('panel-A', 'session-A')
  check('the requesting chat still receives it later', forA?.method === 'navigate', JSON.stringify(forA?.method))
  settleOk(bridge, 'panel-A', forA, { url: 'https://a.test' })
  const result = await pending
  check('the call completes in the requesting chat', result.url === 'https://a.test', JSON.stringify(result))
  bridge.close()
}

console.log('\n--- a closed panel stops being authoritative ------------------')

{
  const bridge = new BrowserBridge({ timeoutMs: 1000 })
  bridge.poll('panel-A', 'session-A')
  check('attached before the panel goes away', bridge.attachedTo('session-A') === true)
  // Simulate the panel dying by never polling again; the TTL is one minute so
  // use the public escape hatch instead: closing the bridge.
  bridge.close()
  check('a closed bridge detaches every conversation', bridge.attachedTo('session-A') === false)
}

console.log(failures.length === 0 ? '\nSESSION BINDING OK' : `\nSESSION BINDING FAILED (${failures.length})`)
process.exit(failures.length === 0 ? 0 : 1)
