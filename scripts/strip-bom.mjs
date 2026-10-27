import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync, statSync } from 'node:fs'

/** Repository root, one level above this script. */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Every text file that must be BOM-free for tooling to parse it. */
function collect(dir, found = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) collect(path, found)
    else if (/\.(js|mjs|json|yml|yaml|md)$/.test(name)) found.push(path)
  }
  return found
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf])
let fixed = 0

for (const path of collect(root)) {
  const bytes = readFileSync(path)
  if (bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]) {
    writeFileSync(path, bytes.subarray(3))
    console.log(`去掉 BOM: ${path.slice(root.length + 1)}`)
    fixed += 1
  }
}

console.log(`\n共修复 ${fixed} 个文件`)
