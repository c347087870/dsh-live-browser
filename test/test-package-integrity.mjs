/**
 * 发布产物完整性检查。
 *
 * 这一组断言防的是「文件本身写得对，但 DSH 读不了」这类问题。最典型的一次：
 * package.json 开头混进 UTF-8 BOM，JSON 解析器直接报
 *
 *   SyntaxError: Unexpected token '锘?, "锘縶 "na"... is not valid JSON
 *
 * 于是 DSH 判定安装包无法校验，把 package.json、pnpm-lock.yaml 和 node_modules
 * 全部回滚，插件一直不加载。工具和路由都不存在，但代码本身毫无问题，极难排查。
 *
 * 这些检查不需要浏览器，也不依赖 DSH，纯粹读仓库里的文件。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const failures = []
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS ${label}`)
  else { failures.push(label); console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

const BOM = [0xef, 0xbb, 0xbf]
const isBom = (bytes) => bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]

/** 收集仓库里所有文本文件，跳过依赖与版本库目录。 */
function collectTextFiles(dir, found = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) collectTextFiles(path, found)
    else if (/\.(js|mjs|cjs|json|yml|yaml|md|txt)$/.test(name)) found.push(path)
  }
  return found
}

// ---------------------------------------------------------------------------
// 没有任何文本文件可以带 BOM
// ---------------------------------------------------------------------------

{
  const offenders = []
  for (const path of collectTextFiles(root)) {
    if (isBom(readFileSync(path))) offenders.push(relative(root, path))
  }
  check('仓库里没有带 BOM 的文本文件', offenders.length === 0, offenders.join(', '))
}

// ---------------------------------------------------------------------------
// package.json 必须是合法 JSON，且声明了 DSH 组合包
// ---------------------------------------------------------------------------

{
  const path = join(root, 'package.json')
  const raw = readFileSync(path)

  let parsed
  let parseError
  try {
    // 用 JSON.parse 而不是 require，这样 BOM 会像 DSH 那样真的失败。
    parsed = JSON.parse(raw.toString('utf8'))
  } catch (error) {
    parseError = String(error.message)
  }

  check('package.json 能被 JSON.parse 解析', parseError === undefined, parseError)
  check('package.json 首字节不是 BOM', !isBom(raw), Array.from(raw.subarray(0, 3)).join(','))

  if (parsed !== undefined) {
    check('声明了 dsh.plugin', parsed.dsh?.plugin === true, JSON.stringify(parsed.dsh))
    check('声明了 dsh.bundle.patch', typeof parsed.dsh?.bundle?.patch === 'string', JSON.stringify(parsed.dsh?.bundle))
    check('main 指向 lib/index.js', parsed.main === 'lib/index.js', parsed.main)
    check('有 repository 字段（市场靠它识别已安装）', typeof parsed.repository?.url === 'string', JSON.stringify(parsed.repository))
    check('有 license 字段', typeof parsed.license === 'string', parsed.license)
    check('声明了 schemastery 依赖（装到别的环境也能解析）', typeof parsed.dependencies?.schemastery === 'string', JSON.stringify(parsed.dependencies))
    check(
      'DSH 宿主接口包只出现在 peerDependencies',
      parsed.dependencies === undefined
        || !Object.keys(parsed.dependencies).some((name) => name.startsWith('@deepseek-ai/')),
      JSON.stringify(parsed.dependencies),
    )

    // 清单里声明的每个文件都必须真实存在，否则安装后立刻缺文件。
    for (const entry of parsed.files ?? []) {
      const normalized = entry.replace(/\/$/, '')
      const exists = (() => {
        try {
          return statSync(join(root, normalized)) !== undefined
        } catch {
          return false
        }
      })()
      check(`清单声明的 ${normalized} 存在`, exists)
    }
  }
}

// ---------------------------------------------------------------------------
// 组合包清单必须存在且能被 YAML 读懂
// ---------------------------------------------------------------------------

{
  const path = join(root, 'cordis.patch.yml')
  let text
  try {
    text = readFileSync(path, 'utf8')
    check('cordis.patch.yml 存在且可读', true)
  } catch (error) {
    check('cordis.patch.yml 存在且可读', false, String(error.message))
  }
  if (text !== undefined) {
    check('组合包清单注册了本插件', text.includes('dsh-live-browser'), text.slice(0, 80))
    check('组合包清单没有 BOM', !isBom(readFileSync(path)))
  }
}

// ---------------------------------------------------------------------------
// 入口文件真实存在，且与 package.json 的 exports 对应
// ---------------------------------------------------------------------------

{
  const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  for (const [subpath, target] of Object.entries(parsed.exports ?? {})) {
    const resolved = typeof target === 'string' ? target : target?.default
    if (typeof resolved !== 'string') continue
    let exists = false
    try {
      exists = statSync(join(root, resolved)) !== undefined
    } catch {
      exists = false
    }
    check(`exports["${subpath}"] 指向的 ${resolved} 存在`, exists)
  }
}

// ---------------------------------------------------------------------------
// 运行时代码不含调试残留（分发文件必须干净）
// ---------------------------------------------------------------------------

{
  const runtimeFiles = ['lib/agent-script.js', 'lib/bridge.js', 'lib/config.js', 'lib/index.js', 'lib/rpc.js', 'lib/schema.js', 'lib/skills.js', 'lib/tools.js', 'client.js']
  const noisy = []
  for (const file of runtimeFiles) {
    const text = readFileSync(join(root, file), 'utf8')
    // console.log 会写进 DSH 的宿主输出；调试残留不该随发布。
    if (/console\.log\(/.test(text)) noisy.push(file)
  }
  check('运行时代码里没有 console.log 残留', noisy.length === 0, noisy.join(', '))
}

console.log(failures.length === 0 ? '\n包完整性 OK' : `\n包完整性失败（${failures.length}）`)
process.exit(failures.length === 0 ? 0 : 1)
