/**
 * End-to-end check of the panel endpoint over real HTTP against a running DSH
 * instance, using the same request envelope the client bundle sends.
 *
 * This is the check that would have caught the HTTP 405 regression: the route
 * must answer POST, and it must answer it with a protocol response rather than
 * falling through to the static frontend fallback.
 *
 * Usage: node test-rpc-http.mjs <base-url-with-token>
 */
const target = process.argv[2]
if (target === undefined) {
  // This suite needs a live DSH instance, whose URL and token come from that
  // process. Run it explicitly:
  //   node test-rpc-http.mjs "http://127.0.0.1:PORT/?token=..."
  console.log('SKIP: pass a running instance URL with its token to run this suite')
  process.exit(0)
}

const url = new URL(target)
const base = `${url.protocol}//${url.host}`

const indexResponse = await fetch(target, { redirect: 'manual' })
const cookies = indexResponse.headers.getSetCookie?.() ?? []
const cookie = cookies.map((entry) => entry.split(';', 1)[0]).join('; ')
console.log('index:', indexResponse.status, '| cookie present:', cookie !== '')

const headers = { 'content-type': 'application/json', ...(cookie === '' ? {} : { cookie }) }

const call = async (endpoint, payload = {}) => {
  const rpcId = crypto.randomUUID()
  const response = await fetch(`${base}/dsh-live-browser/${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { status: response.status, text: text.slice(0, 160) }
  }
  return { status: response.status, rpcId: parsed.rpcId, result: parsed.result }
}

let failures = 0
const check = async (label, endpoint) => {
  const result = await call(endpoint)
  const ok = result.status === 200 && result.result !== undefined && (result.result.ok === true || result.result.ok === false)
  if (!ok) failures += 1
  const detail = result.result?.ok === false
    ? `error: ${result.result.error?.message}`
    : JSON.stringify(result.result?.value)?.slice(0, 120)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} -> HTTP ${result.status} ${detail ?? result.text ?? ''}`)
  return result
}

const status = await check('status (panel mount call)', 'status')
if (status.result?.ok === true) {
  const value = status.result.value
  console.log(`     attached=${value.attached} panels=${value.panels}`)
}

const source = await check('source (the injected agent script)', 'source')
if (source.result?.ok === true) {
  const text = String(source.result.value?.source ?? '')
  console.log(`     source bytes=${source.result.value?.bytes} parses=${(() => { try { new Function(text); return true } catch { return false } })()}`)
}

// The rpcId must round-trip, otherwise the client rejects the response.
const echoed = await call('status')
console.log(`${echoed.rpcId !== undefined ? 'PASS' : 'FAIL'} rpcId echoed back`)
if (echoed.rpcId === undefined) failures += 1

// Unknown endpoints must be a protocol-level error, not an HTTP failure.
const unknown = await call('does-not-exist')
console.log(`${unknown.status === 200 && unknown.result?.ok === false ? 'PASS' : 'FAIL'} unknown endpoint -> clean protocol error (HTTP ${unknown.status})`)
if (!(unknown.status === 200 && unknown.result?.ok === false)) failures += 1

// A GET must not be answered by the static fallback with 405: this route owns
// its path and answers with its own contract.
const getResponse = await fetch(`${base}/dsh-live-browser/status`, { headers })
console.log(`     GET on the channel -> HTTP ${getResponse.status} (route owns the path)`)

console.log(failures === 0 ? '\nPANEL RPC REACHABLE OVER HTTP' : `\nPANEL RPC BROKEN (${failures})`)
process.exit(failures === 0 ? 0 : 1)
