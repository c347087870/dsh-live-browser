/**
 * Suite runner: executes every `test-*.mjs` in order and reports a summary.
 *
 * Some suites drive a real page through the CDP harness in `test-fixtures/`.
 * That harness exists only for testing: the shipped plugin drives DSH's own
 * sidebar browser and never touches Chrome directly. Those suites need a browser
 * already listening on the debug port; this runner never launches one, because
 * starting an external browser is a decision for the person running the tests.
 * With no browser up they report SKIP instead of failing.
 */
import { readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testBrowserConfig } from './browser-config.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const only = process.argv.slice(2)

/**
 * Suites that still need a real browser on the debug port.
 *
 * test-bridge-e2e and the DOM behaviour suite used to be here; both now run
 * against jsdom, so they are no longer gated on a browser.
 */
const needsBrowser = (name) =>
  ['test-chart-capture.mjs', 'test-scenarios.mjs'].includes(name)

/** Probe the debug port without launching anything. */
const probeBrowser = async () => {
  try {
    const response = await fetch(`http://127.0.0.1:${testBrowserConfig.debugPort}/json/version`)
    return response.ok ? await response.json() : undefined
  } catch {
    return undefined
  }
}

const files = readdirSync(here)
  .filter((name) => /^test-.*\.mjs$/.test(name) && name !== 'test-all.mjs')
  .filter((name) => only.length === 0 || only.some((needle) => name.includes(needle)))
  .sort()

const wantedBrowser = files.some((name) => needsBrowser(name))
const browser = wantedBrowser ? await probeBrowser() : undefined

if (wantedBrowser) {
  if (browser === undefined) {
    console.log(
      `browser: not running on port ${testBrowserConfig.debugPort} — page suites will be skipped`,
    )
    console.log('  start one with: node scripts/ensure-browser.mjs')  } else {
    console.log(`browser: ${browser.Browser ?? 'running'}`)
  }
}

const runOne = (file) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, file)], { cwd: here, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { out += chunk })
    child.on('close', (code) => resolve({ file, code, out }))
  })

const results = []
let totalPassed = 0
let totalFailed = 0
for (const file of files) {
  process.stdout.write(`\n=== ${file} ===\n`)
  const result = await runOne(file)
  results.push(result)
  const lines = result.out.trim().split(/\r?\n/)
  const passed = lines.filter((line) => /^PASS\b/.test(line.trim())).length
  const failed = lines.filter((line) => /^FAIL\b/.test(line.trim())).length
  totalPassed += passed
  totalFailed += failed
  const interesting = lines.filter((line) => /^(PASS|FAIL|SKIP|✔|✘|OK|.*OK$|.*FAILED)/.test(line.trim()))
  for (const line of interesting.slice(0, 60)) console.log(line)
  if (interesting.length === 0) console.log(lines.slice(-8).join('\n'))
}

/**
 * A suite that ran nothing has not passed, it has not run.
 *
 * Reporting "PASS test-rpc-http.mjs (0 passed, 0 failed)" counted a suite that
 * bailed out on its own precondition as a success, so the summary could claim
 * 10/10 while one check never executed.
 */
const wasSkipped = (result) => /^SKIP\b/m.test(result.out) && !/^PASS\b/m.test(result.out)
const failures = results.filter((result) => result.code !== 0)
const skipped = results.filter((result) => result.code === 0 && wasSkipped(result))
const ran = results.length - skipped.length

console.log('\n================ SUMMARY ================')
for (const result of results) {
  const lines = result.out.trim().split(/\r?\n/)
  const passed = lines.filter((line) => /^PASS\b/.test(line.trim())).length
  const failed = lines.filter((line) => /^FAIL\b/.test(line.trim())).length
  const label = result.code !== 0 ? 'FAIL' : wasSkipped(result) ? 'SKIP' : 'PASS'
  console.log(`${label}  ${result.file}  (${passed} passed, ${failed} failed)`)
}
console.log(`\n${ran - failures.length}/${ran} suites passed${skipped.length === 0 ? '' : `, ${skipped.length} skipped`}`)
if (skipped.length > 0) {
  console.log(`skipped: ${skipped.map((result) => result.file).join(', ')}`)
  console.log('  test-rpc-http.mjs needs a running DSH: node test-rpc-http.mjs <base-url-with-token>')
}
console.log(`${totalPassed} assertions passed, ${totalFailed} failed`)
process.exit(failures.length === 0 ? 0 : 1)
