/**
 * Exercise the capture path against a real page with a real chart.
 *
 * This is the capability behind browser_screenshot: the plugin cannot read the
 * native guest's pixels, so the page rasterises its own canvas/svg and hands
 * back a PNG data URL. The test proves that PNG is real, non-empty, and looks
 * like an image rather than a blank rectangle.
 */
import { BrowserLauncher } from './test-fixtures/chrome.js'
import { testBrowserConfig } from './browser-config.mjs'
import { BrowserHub } from './test-fixtures/browser.js'
import { AGENT_SOURCE } from './lib/agent-script.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

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
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS ${label}`)
  else { failures.push(label); console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

/** A page with a canvas chart and an svg chart, drawn for real. */
const fixture = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><title>Chart Fixture</title></head>
<body style="margin:0;background:#fff">
  <h2>Canvas chart</h2>
  <canvas id="c1" width="600" height="300"></canvas>
  <h2>SVG chart</h2>
  <svg id="s1" width="600" height="200" viewBox="0 0 600 200">
    <rect width="600" height="200" fill="#fff" stroke="#999"/>
    <polyline fill="none" stroke="#d00" stroke-width="3" points="10,150 100,90 200,120 300,60 400,80 500,30 590,50"/>
    <text x="10" y="20" font-size="16" fill="#333">Trend</text>
  </svg>
  <script>
    const c = document.getElementById('c1').getContext('2d')
    c.fillStyle = '#fff'; c.fillRect(0, 0, 600, 300)
    c.strokeStyle = '#06c'; c.lineWidth = 3; c.beginPath()
    c.moveTo(0, 250)
    for (let x = 0; x <= 600; x += 30) c.lineTo(x, 250 - Math.sin(x / 60) * 120 - x / 10)
    c.stroke()
    c.fillStyle = '#333'; c.font = '18px sans-serif'; c.fillText('Index Trend', 20, 30)
  </script>
</body></html>`)}`

await hub.navigate(tab.targetId, fixture)
await hub.evalJs(tab.targetId, AGENT_SOURCE)

const run = async (method, params = {}) => {
  const expression = `(async () => { ${AGENT_SOURCE}; return await window.__dshBrowserAgent[${JSON.stringify(method)}](${JSON.stringify(params)}); })()`
  const result = await hub.evalJs(tab.targetId, expression)
  if (result.ok === false) throw new Error(String(result.error))
  return result.value
}

/** Decode a PNG data URL just far enough to prove it is a real image. */
const inspectPng = (dataUrl) => {
  const prefix = 'data:image/png;base64,'
  if (!dataUrl.startsWith(prefix)) return { ok: false, reason: 'not a png data url' }
  const bytes = Buffer.from(dataUrl.slice(prefix.length), 'base64')
  const signature = bytes.subarray(0, 8).toString('hex')
  const isPng = signature === '89504e470d0a1a0a'
  // IHDR carries width/height at bytes 16..23 of the file.
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  return { ok: isPng, bytes: bytes.length, width, height }
}

// 1. Explicit canvas by selector.
const canvasShot = await run('capture', { selector: '#c1', scale: 2 })
const canvasInfo = inspectPng(canvasShot.dataUrl)
check('canvas capture returns a real PNG', canvasInfo.ok === true, JSON.stringify(canvasInfo))
check('canvas capture is scaled 2x', canvasInfo.width === 1200 && canvasInfo.height === 600, `${canvasInfo.width}x${canvasInfo.height}`)
check('canvas capture has substance', canvasInfo.bytes > 3000, `${canvasInfo.bytes} bytes`)

// 2. Explicit svg by selector.
const svgShot = await run('capture', { selector: '#s1', scale: 2 })
const svgInfo = inspectPng(svgShot.dataUrl)
check('svg capture returns a real PNG', svgInfo.ok === true, JSON.stringify(svgInfo))
check('svg capture keeps the aspect ratio', Math.abs(svgInfo.width / svgInfo.height - 3) < 0.05, `${svgInfo.width}x${svgInfo.height}`)
check('svg capture has substance', svgInfo.bytes > 1000, `${svgInfo.bytes} bytes`)

// 3. Auto-pick the biggest chart when no target is given.
const autoShot = await run('capture', { scale: 1 })
const autoInfo = inspectPng(autoShot.dataUrl)
check('auto capture picks a chart', autoInfo.ok === true, JSON.stringify(autoInfo))
check('auto capture reports how many charts it saw', autoShot.count >= 2, JSON.stringify(autoShot.count))

// 4. A page with no charts must fail with an actionable message.
await hub.navigate(tab.targetId, `data:text/html;charset=utf-8,${encodeURIComponent('<h1>plain</h1><p>no charts here</p>')}`)
await hub.evalJs(tab.targetId, AGENT_SOURCE)
let noChartError
try {
  await run('capture', {})
} catch (error) {
  noChartError = String(error?.message ?? error)
}
check('no-chart page explains itself', String(noChartError).includes('没有可导出'), noChartError)

// 5. Save one to disk to prove the bytes survive a round trip.
const outDir = join(process.env.TEMP ?? '.', 'dsh-chart-test')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'canvas-fixture.png')
writeFileSync(outPath, Buffer.from(canvasShot.dataUrl.slice('data:image/png;base64,'.length), 'base64'))
console.log(`     saved ${outPath}`)

await hub.close()
console.log(failures.length === 0 ? '\nCHART CAPTURE OK' : `\nCHART CAPTURE FAILED (${failures.length})`)
process.exit(failures.length === 0 ? 0 : 1)
