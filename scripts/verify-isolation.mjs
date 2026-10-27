/**
 * Verify a client bundle is isolated from sibling declarations in the shared
 * combo <script>: concatenate it with probe declarations that other plugins use
 * and confirm the combined script still parses.
 *
 * Usage: node verify-isolation.mjs <client.js> [...more]
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'

const PROBES = [
  'const DICTIONARY = 1;',
  'function nodeArrayOf() {}',
  'const useLanguage = 1;',
  'function escapeHtml() {}',
]

let failures = 0
for (const target of process.argv.slice(2)) {
  const source = readFileSync(target, 'utf8')
  const probePath = join(tmpdir(), `${basename(target)}.isolation-probe.js`)
  writeFileSync(probePath, `${source}\n${PROBES.join('\n')}\n`, 'utf8')
  const parsed = spawnSync(process.execPath, ['--check', probePath], { encoding: 'utf8' })
  rmSync(probePath, { force: true })
  const ok = parsed.status === 0
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${target}`)
  if (!ok) console.log(`     ${(parsed.stderr ?? '').trim().split(/\r?\n/)[0]}`)
}

console.log(failures === 0 ? '\nALL BUNDLES ISOLATED' : `\n${failures} bundle(s) leak into shared scope`)
process.exit(failures === 0 ? 0 : 1)
