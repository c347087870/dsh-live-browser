/**
 * Wrap a plugin client bundle in an IIFE so its top-level declarations cannot
 * collide with sibling bundles in DSH's combo <script>.
 *
 * Usage: node wrap-client-iife.mjs <path-to-client.js>
 */
import { readFileSync, writeFileSync } from 'node:fs'

const target = process.argv[2]
if (target === undefined) {
  console.error('usage: node wrap-client-iife.mjs <client.js>')
  process.exit(2)
}

const source = readFileSync(target, 'utf8')
if (source.includes(';(function () {')) {
  console.log('already wrapped')
  process.exit(0)
}

// Keep the leading license/comment block outside the wrapper for readability.
const marker = "'use strict'"
const at = source.indexOf(marker)
if (at === -1) {
  console.error('no \'use strict\' marker found; refusing to guess the body start')
  process.exit(1)
}

const head = source.slice(0, at)
const body = source.slice(at)
const wrapped = `${head};(function () {\n${body}\n})()\n`
writeFileSync(target, wrapped, 'utf8')
console.log(`wrapped ${target} (${wrapped.length} bytes)`)
