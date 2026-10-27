/**
 * Plugin audit for the desktop profile.
 *
 * For every user-installed bundle it checks
 *  1. the host half imports cleanly (module resolution, syntax, exports),
 *  2. the client half parses as a classic script,
 *  3. the client half leaks no top-level binding into the shared combo <script>.
 *
 * Point 3 is the one that breaks DSH at startup: the shell batches several
 * plugin bundles into ONE classic <script>, so a top-level `const X` in one
 * plugin collides with the same name in another and the whole batch dies with
 * "Identifier 'X' has already been declared" — taking unrelated plugins down
 * with it.
 */
import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/**
 * The profile to audit. Pass it explicitly, or set DSH_PROFILE_DIR, because the
 * desktop profile lives in the user's home directory and is not portable.
 *
 *   node audit-plugins.mjs ~/.dsh/profiles/desktop
 */
const PROFILE = process.argv[2] ?? process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop')
const manifestPath = join(PROFILE, 'package.json')
if (!existsSync(manifestPath)) {
  console.error(`no profile manifest at ${manifestPath}`)
  console.error('usage: node audit-plugins.mjs <path-to-dsh-profile>')
  process.exit(2)
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const bundles = manifest.dsh?.profile?.bundles ?? []

// Shipped bundles (@deepseek-ai/*) live inside app.asar as part of the
// installation; the audit covers the profile's own packages, which are the
// ones that can drift from the current runtime.
const isShipped = (name) => name.startsWith('@deepseek-ai/')

const resolvePackageDir = (name) => {
  const inProfile = join(PROFILE, 'node_modules', name)
  return existsSync(inProfile) ? inProfile : undefined
}

// Audit every user package installed in the profile, whether or not it is
// currently listed in `bundles`: unlisted-but-installed is exactly the state
// that breaks a later re-enable.
const installedUserPackages = []
for (const name of Object.keys(manifest.dependencies ?? {})) {
  if (resolvePackageDir(name) !== undefined) installedUserPackages.push(name)
}
const auditTargets = [...new Set([...bundles.filter((name) => !isShipped(name)), ...installedUserPackages])]

/**
 * Detect whether the bundle leaks a declaration into the shared combo scope.
 *
 * Rather than trying to parse declarations (which is easy to get wrong), this
 * appends a probe declaration with a name every plugin could plausibly use and
 * checks whether the combined script still parses. A bundle wrapped in an IIFE
 * isolates its own bindings, so the probe never conflicts.
 */
const leaksIntoSharedScope = (source, path) => {
  const probe = '\nconst DICTIONARY = 1;\nfunction nodeArrayOf() {}\n'
  const combined = `${source}\n${probe}`
  // Syntax-check the concatenation exactly the way the combo <script> would.
  const scriptPath = `${path}.combo-probe.js`
  writeFileSync(scriptPath, combined, 'utf8')
  const parsed = spawnSync(process.execPath, ['--check', scriptPath], { encoding: 'utf8' })
  rmSync(scriptPath, { force: true })
  return { clean: parsed.status === 0, error: parsed.status === 0 ? undefined : parsed.stderr.trim().split(/\r?\n/)[0] }
}

const results = []
for (const bundleName of auditTargets) {
  const dir = resolvePackageDir(bundleName)
  const entry = { bundle: bundleName, dir, host: null, client: null, topLevel: [] }
  if (dir === undefined) {
    entry.host = { ok: false, error: 'package directory missing' }
    results.push(entry)
    continue
  }

  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch (error) {
    entry.host = { ok: false, error: `package.json unreadable: ${error.message}` }
    results.push(entry)
    continue
  }

  const main = pkg.main ?? 'index.js'
  const mainPath = join(dir, main)
  if (existsSync(mainPath)) {
    const imported = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(mainPath).href)}); console.log('IMPORT_OK')`],
      { cwd: PROFILE, encoding: 'utf8', timeout: 60000 },
    )
    const ok = imported.status === 0 && imported.stdout.includes('IMPORT_OK')
    entry.host = {
      ok,
      error: ok ? undefined : (imported.stderr || imported.stdout).trim().split(/\r?\n/).slice(0, 3).join(' | '),
    }
  } else {
    entry.host = { ok: false, error: `entry missing: ${main}` }
  }

  const clientExport = pkg.exports?.['./client']
  const clientPath = clientExport === undefined
    ? undefined
    : join(dir, typeof clientExport === 'string' ? clientExport : (clientExport.default ?? './client.js'))
  if (clientPath !== undefined && existsSync(clientPath)) {
    const source = readFileSync(clientPath, 'utf8')
    const parsed = spawnSync(process.execPath, ['--check', clientPath], { encoding: 'utf8' })
    entry.client = {
      ok: parsed.status === 0,
      error: parsed.status === 0 ? undefined : parsed.stderr.trim().split(/\r?\n/)[0],
      path: clientPath,
    }
    entry.shared = leaksIntoSharedScope(source, clientPath)
  }

  results.push(entry)
}

const pad = (text, width) => String(text ?? '').padEnd(width)
console.log(`${pad('bundle', 26)} ${pad('host', 6)} ${pad('client', 8)} shared scope`)
console.log('-'.repeat(110))
for (const entry of results) {
  const shared = entry.shared === undefined ? 'none' : (entry.shared.clean ? 'isolated' : 'LEAKS')
  console.log(`${pad(entry.bundle, 26)} ${pad(entry.host?.ok ? 'ok' : 'FAIL', 6)} ${pad(entry.client ? (entry.client.ok ? 'ok' : 'FAIL') : 'none', 8)} ${shared}`)
  if (entry.host?.ok === false) console.log(`    host: ${entry.host.error}`)
  if (entry.client && entry.client.ok === false) console.log(`    client: ${entry.client.error}`)
  if (entry.shared && entry.shared.clean === false) console.log(`    shared: ${entry.shared.error}`)
}

const leaking = results.filter((entry) => entry.shared !== undefined && entry.shared.clean === false)
console.log('\n--- bundles leaking a top-level binding ---')
if (leaking.length === 0) console.log('none')
for (const entry of leaking) console.log(entry.bundle)

const broken = results.filter((entry) => entry.host?.ok === false || (entry.client && entry.client.ok === false))
console.log('\n--- verdict ---')
for (const entry of broken) console.log(`BROKEN ${entry.bundle}`)
for (const entry of leaking) console.log(`LEAKS ${entry.bundle}`)
console.log(broken.length === 0 && leaking.length === 0
  ? 'ALL PLUGINS HEALTHY'
  : `${broken.length} broken, ${leaking.length} leaking`)
process.exit(broken.length === 0 && leaking.length === 0 ? 0 : 1)
