/**
 * 内置浏览器实机验证用的临时页面与本地服务。
 *
 * 这几个页面只服务于手工/agent 实测，不属于测试夹具，所以写在仓库之外。
 *
 *   node scripts/verify-in-browser.mjs            # 生成页面并打印要做的断言
 *   node scripts/verify-in-browser.mjs --serve    # 起本地服务（默认 8899 端口）
 *   node scripts/verify-in-browser.mjs --check    # 确认服务与页面都就绪
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', 'dsh-live-browser-verify')
const port = Number(process.env.DSH_VERIFY_PORT ?? 8899)

const pages = {
  'pointer.html': `<!doctype html><html><head><meta charset="utf-8"><title>pointer</title></head><body>
<button id="p">pointer</button>
<div id="flag">none</div>
<div id="seen"></div>
<script>
  const seen = []
  for (const t of ['pointerover','pointerenter','pointerdown','pointerup','mousedown','mouseup','click']) {
    const el = document.getElementById('p')
    el.addEventListener(t, () => { seen.push(t); document.getElementById('seen').textContent = seen.join(',') })
  }
  // 只监听 pointerdown 的库（拖拽类）能收到事件吗？
  document.getElementById('p').addEventListener('pointerdown', () => {
    document.getElementById('flag').textContent = 'caught'
  })
  window.readSeen = () => seen.join(',')
</script></body></html>`,

  'keys.html': `<!doctype html><html><head><meta charset="utf-8"><title>editing keys</title></head><body>
<input id="e" value="abc">
<textarea id="t">line</textarea>
<div id="c" contenteditable="true">editable</div>
</body></html>`,

  'link.html': `<!doctype html><html><head><meta charset="utf-8"><title>link</title></head><body>
<a id="a" href="/target.html">go</a></body></html>`,

  'target.html': `<!doctype html><html><head><meta charset="utf-8"><title>REACHED</title></head>
<body><h1 id="ok">NAV OK</h1></body></html>`,
}

mkdirSync(root, { recursive: true })
for (const [name, html] of Object.entries(pages)) writeFileSync(join(root, name), html, 'utf8')

/** 处理一次请求：只认精确文件名，不做模糊回退。 */
function serve(request, response) {
  const name = request.url.split('?')[0].replace(/^\//, '')
  const html = pages[name]
  if (html === undefined) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(`not found: ${name}`)
    return
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(html)
}

if (process.argv.includes('--serve')) {
  createServer(serve).listen(port, '127.0.0.1', () => {
    console.log(`serving on http://127.0.0.1:${port}`)
  })
} else if (process.argv.includes('--check')) {
  let bad = 0
  for (const name of Object.keys(pages)) {
    const path = join(root, name)
    if (!existsSync(path)) { console.log(`MISSING ${name}`); bad += 1 }
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/pointer.html`)
    console.log(`服务 http://127.0.0.1:${port} -> ${response.status}`)
    if (!response.ok) bad += 1
  } catch {
    console.log(`服务未启动（先跑 --serve）`)
    bad += 1
  }
  console.log(bad === 0 ? '\n验证环境就绪' : `\n验证环境有问题（${bad}）`)
  process.exit(bad === 0 ? 0 : 1)
} else {
  console.log(`页面已写入 ${root}\n`)
  console.log('在内置浏览器里逐条验证：\n')
  console.log('pointer.html')
  console.log('  browser_click 按钮 <button> 之后读 window.readSeen()')
  console.log('    必须同时出现 pointerdown、pointerup、mousedown、mouseup、click')
  console.log('  读 #flag 的文本 -> 应为 caught（只监听 pointerdown 的库也能收到）')
  console.log('')
  console.log('keys.html')
  console.log('  browser_press {selector:"#e", key:"Backspace"} -> value 变成 "ab"')
  console.log('  browser_press {selector:"#e", key:"Shift+A"}   -> value 追加 "A"（不是 "+A"）')
  console.log('  browser_press {selector:"#e", key:"Control+a"} -> value 清空')
  console.log('  browser_press {selector:"#t", key:"Enter"}     -> textarea 里出现换行')
  console.log('  browser_type  {selector:"#c", text:"ok"}       -> contenteditable 文本变成 ok')
  console.log('')
  console.log('link.html')
  console.log('  browser_click 链接 <a> -> 跳到 target.html，标题 REACHED')
  console.log('')
  console.log('ref 生命周期（任意页面）')
  console.log('  连续两次 browser_snapshot -> ref 不应累积')
}
