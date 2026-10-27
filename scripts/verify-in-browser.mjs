/**
 * Verification checklist for the five suites that need a real page.
 *
 * Those suites drive page DOM through CDP against an external Chrome, which is
 * not always available (and is not the browser this plugin actually operates).
 * This script is the manual equivalent: it writes the pages, prints exactly what
 * to check, and can also be driven by the plugin's own browser_* tools once DSH
 * has loaded them — same assertions, same expected values.
 *
 *   node scripts/verify-in-browser.mjs
 *
 * Start the local server with:
 *
 *   node scripts/verify-in-browser.mjs --serve
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// Written outside the repository: these are throwaway pages for a manual check,
// not fixtures anyone should commit.
const root = join(here, '..', '..', 'dsh-live-browser-verify')

const pages = {
  'pointer.html': `<!doctype html><html><head><meta charset="utf-8"><title>pointer</title></head><body>
<button id="p">pointer</button><div id="seen"></div>
<script>
  const seen = []
  for (const t of ['pointerover','pointerenter','pointerdown','pointerup','mousedown','mouseup','click']) {
    document.getElementById('p').addEventListener(t, () => seen.push(t))
  }
  window.readSeen = () => seen.join(',')
</script></body></html>`,

  'keys.html': `<!doctype html><html><head><meta charset="utf-8"><title>editing keys</title></head><body>
<input id="e" value="abc"><textarea id="t">line</textarea></body></html>`,

  'link.html': `<!doctype html><html><head><meta charset="utf-8"><title>link</title></head><body>
<a id="a" href="/target.html">go</a></body></html>`,

  'target.html': `<!doctype html><html><head><meta charset="utf-8"><title>REACHED</title></head>
<body><h1 id="ok">NAV OK</h1></body></html>`,
}

mkdirSync(root, { recursive: true })
for (const [name, html] of Object.entries(pages)) writeFileSync(join(root, name), html, 'utf8')

if (process.argv.includes('--serve')) {
  const port = 8899
  createServer((request, response) => {
    try {
      const body = Buffer.from(pages[request.url.slice(1)] ?? pages['pointer.html'])
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(body)
    } catch {
      response.writeHead(404)
      response.end('not found')
    }
  }).listen(port, '127.0.0.1', () => console.log(`serving on http://127.0.0.1:${port}`))
} else {
  console.log(`pages written to ${root}\n`)
  console.log('Assertions to run in the DSH sidebar browser:')
  console.log('')
  console.log('pointer.html')
  console.log('  browser_click the <button>, then: window.readSeen()')
  console.log('    must contain pointerdown AND pointerup AND mousedown AND mouseup AND click')
  console.log('')
  console.log('keys.html')
  console.log('  browser_press {selector:"#e", key:"Backspace"}  -> value becomes "ab"')
  console.log('  browser_press {selector:"#e", key:"X"}          -> value becomes "abX"')
  console.log('  browser_press {selector:"#e", key:"Control+a"}  -> value becomes ""')
  console.log('  browser_press {selector:"#t", key:"Enter"}      -> textarea contains a newline')
  console.log('  browser_press {selector:"#e", key:"ArrowDown"}  -> value unchanged')
  console.log('')
  console.log('link.html')
  console.log('  browser_click the <a>                           -> lands on target.html, title REACHED')
  console.log('')
  console.log('ref lifecycle (any page)')
  console.log('  browser_snapshot twice -> Object.keys(window.__dshRefs).length <= node count')
}
