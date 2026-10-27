# dsh-live-browser

让 agent 操作 DSH 自带的那个浏览器 —— 就在 DSH 里，什么都不离开窗口。

中文 | [English](README.en.md)

DSH 自带的 `@deepseek-ai/dsh-client-ui-sidebar-browser` 会在右侧栏渲染一个真正的
Electron `<webview>`，带地址栏、历史记录和独立的浏览器会话。但它只开放了导航能力：
agent 能打开页面，却点不了、输不进、读不到、滚不动。

这个插件在**不修改 DSH 任何文件**的前提下补上这一段：找到官方插件挂载的那些 guest，
往每个文档里注入一套操作接口，再给模型 25 个 `browser_*` 工具，操作的正是用户眼前那张页面。

## 安装

需要 DSH 0.2.x 与 Node.js 20 以上。插件在 `package.json` 里声明了 DSH 组合包，安装时
DSH 会自动注册。

### 从 GitHub 安装

```bash
# Web / CLI profile
dsh plugin --profile web install c347087870/dsh-live-browser
```

桌面版的 profile 由 Electron 应用独占，请从界面安装：**插件 → 添加插件**，粘贴
`https://github.com/c347087870/dsh-live-browser`，然后重启 DSH。

### 从 npm 安装

```bash
dsh plugin --profile web install dsh-live-browser
```

### 确认装好了

```bash
node -e "const p=require('./node_modules/dsh-live-browser/package.json');console.log(p.version, p.dsh)"
```

`dsh.bundle.patch` 必须存在，`lib/index.js` 必须存在。重启后日志里会出现
`[dsh-live-browser] loaded: 25 tools, driving the DSH sidebar browser`。

> 本地开发**不要**用 junction（`mklink /J`、`ln -s`）：Node 会解析真实路径，于是
> `schemastery` 去源码目录找而不是去 profile 找。要么复制整个包目录，要么用
> `dsh plugin` 安装。

## 配置项

DSH 会把这些渲染在插件的设置卡片里。每一项都有默认值，不动也能用。

| 配置 | 默认 | 含义 |
|---|---|---|
| `confirmSensitive` | `true` | 标记为 `sensitive` 的动作执行前先问用户 |
| `allowEval` | `true` | 是否允许 `browser_eval` 在页面里执行任意 JavaScript |
| `autoOpenPanel` | `true` | 命令到达但没有页面时，自动打开侧边栏浏览器 |
| `commandTimeoutMs` | `30000` | 单次命令等待面板执行的超时（毫秒） |
| `openPanelWaitMs` | `8000` | 打开面板后等待其就绪的时间 |
| `maxSnapshotNodes` | `400` | `browser_snapshot` 默认节点上限 |
| `maxTextChars` | `12000` | `browser_read_text` 默认字符上限 |
| `waitTimeoutMs` | `10000` | `browser_wait` 默认超时（毫秒） |
| `uploadMaxBytes` | `16777216` | `browser_upload` 单个文件的上限 |
| `imageDir` | 空 | `browser_screenshot` 的图片目录；留空用 `~/.dsh/storages/dsh-live-browser/images` |
| `downloadsDir` | 空 | `browser_downloads` 读取的目录；留空用系统「下载」文件夹 |

想让 agent 只读页面、不在页面里跑代码，就把 `allowEval` 关掉。`browser_eval` 随后
返回 `executed: false`，并提示改用 `browser_snapshot` / `browser_read_text`。

## 浏览器会自己打开

agent 不会先让你去开浏览器，也永远不会去开外部窗口：

- 工具把命令排进宿主队列，并标记它来自**哪个对话**。
- 插件的客户端 bundle 一直在轮询，即使当前一个浏览器标签页都没有。
- 命令到达时如果没有页面，客户端会自己调用侧边栏的
  `openTabIn(sessionId, 'browser', …)` 打开浏览器标签页，等 guest 挂载好再执行。

所以冷启动时一句 `browser_navigate`，表现就是右侧栏自己弹出一个标签页并加载目标地址。

### 一个对话一个浏览器

DSH 每个 Session 一个侧边栏，插件遵守这个边界：

- 每条命令都带着发起它的 Session id（宿主侧取 `exec.agent.session.id`）。
- 面板只收到属于自己 Session 的命令，别的对话的面板同时在轮询也抢不走。
- 需要打开浏览器时，用 `openTabIn(sessionId, …)` 在**发起请求的那个对话**里打开，
  而不是在屏幕上恰好显示的那个对话里。

这消除了老的故障模式：在 A 对话要页面，没等它出来就切到 B，结果浏览器出现在 B。

> 为什么打开动作放在渲染层：侧边栏整个在客户端，它的宿主模块什么都不贡献，所以没有
> 宿主服务可调。客户端那一半通过 `ctx.reflect.provide` 发布 `sidebarRight`，插件用的就是这个。

## 为什么用这个形态

| | 本插件 | 直接改官方 bundle |
|---|---|---|
| 点击 / 输入 / 读取 / 滚动 | 可以 | 可以 |
| 把页面图表导成 PNG | 可以，用页面自己的 canvas/SVG | 可以 |
| 截原生窗口 | 不行 | 可以 |
| 经得起 DSH 升级 | 可以 | 不行，每个版本都要重打补丁 |
| 对现有功能的风险 | 无 | 可能破坏侧边栏的链接处理 |

## 工作原理

```
工具调用
      │  bridge.call(method, params)          lib/bridge.js
      ▼
   命令队列  ──────►  面板长轮询              client.js
                          │
                          ├─ 还没有 guest → 打开侧边栏浏览器
                          ├─ 页面命令     → 注入到 guest 里的脚本
                          ├─ 浏览器命令   → guest 元素本身（loadURL/goBack…）
                          └─ 标签页命令   → 侧边栏服务
                          │
                    settle(result)
                          ▼
                      工具结果
```

- **`lib/bridge.js`** —— 队列与长轮询。冷调用会在队列里留够时间让客户端把标签页开出来；
  始终等不到面板的调用会带着可操作的提示失败，而不是一直挂着。
- **`lib/agent-script.js`** —— 注入每个 guest 文档的脚本。纯 DOM：带稳定 `ref` 的快照、
  点击、输入、按键、选择、悬停、滚动、读正文、执行表达式、等待、附加文件、canvas/SVG 转 PNG。
- **`lib/rpc.js`** —— 挂在 DSH web server 上的一个前缀路由（`/dsh-live-browser`），说面板那套
  简单的请求/响应信封。每个请求都校验同源与回环主机，因为这个路由既能写文件（`saveImage`）
  也能读文件（`readUpload`）。
- **`lib/config.js` / `lib/schema.js`** —— 配置值与 DSH 渲染的表单。取值部分不依赖第三方包，
  所以工具层和测试不需要 `node_modules` 就能跑。
- **`client.js`** —— 找到 `webview[data-sidebar-browser-frame="webview"]`，注入脚本，
  需要时打开标签页，跑轮询循环。整体包在 IIFE 里：DSH 会把多个插件 bundle 塞进同一个
  combo `<script>`，顶层 `const` 会跟邻居撞名。

### 为什么不用 `connection.rpc.handle`

在 dsh 0.2.1-rc.2 上，这个 API 用
`owner.effect(() => owner.webServer.register(route))` 建路由，而 `owner` 是 connection
插件自己的 context —— 它从没声明过 `webServer` 依赖。于是属性读取抛
`cannot get property "webServer" without inject`，effect 把错误吞掉，面板请求全部落到
静态前端兜底，表现为 **HTTP 405**。直接在 `webServer` 上注册是同一个调用，只是绕开了
那层坏掉的间接。

## 工具

| 工具 | 作用 |
|---|---|
| `browser_status` | 面板是否打开、当前是什么页面 |
| `browser_open_panel` | 打开侧边栏浏览器（也会自动发生） |
| `browser_navigate` / `back` / `forward` / `reload` | 导航 |
| `browser_snapshot` | 无障碍风格的节点列表，带稳定 `ref` |
| `browser_read_text` | 可见正文，可用选择器限定范围 |
| `browser_click` / `type` / `press` / `select` / `hover` | 页面交互 |
| `browser_scroll` / `wait` | 滚动与等待 |
| `browser_eval` | 在页面里执行一段 JS 表达式 |
| `browser_screenshot` | 把图表（canvas/SVG）或元素导出成 PNG |
| `browser_tabs` / `tab_new` | 列出标签页、新建标签页 |
| `browser_upload` | 给文件输入框附加本地文件 |
| `browser_downloads` | 列出下载目录里的文件 |
| `browser_confirm` | 请用户确认一个不可撤销的动作 |

### 关于标签页

侧边栏把标签页 id 留在内部。插件操作的是获得焦点的那个 guest，没有焦点时用最新的那个；
也没有 `tab` 参数去指别处 —— 这个参数以前存在却被静默丢弃，会让调用方误以为自己指定了
某个标签页。`browser_tabs` 仍然可以列出当前有哪些。

### 说实话的限制

有三件事 DSH 不开放给插件，插件以结构化结果如实报告，而不是假装成功：

- **`browser_tab_close` / `browser_tab_activate`** —— 侧边栏的标签 id 是内部的，工具会
  请你自己去点标签。
- **`browser_reset_profile`** —— 浏览器会话没有开放清理接口，工具返回操作步骤。
- **截原生窗口** —— guest 渲染在原生层，DOM 层面没有像素。`browser_screenshot` 改为让
  页面自己栅格化它的 `<canvas>`/`<svg>`，而这正是图表。

## 安全

- 插件不改 DSH。它读官方侧边栏浏览器渲染出来的 DOM，往官方插件挂载的 guest 里注入脚本。
- `browser_eval` 会在当前加载的任何页面里执行任意 JavaScript。这是这个工具存在的意义，
  也是 `allowEval` 存在的原因。
- `confirmSensitive` 开着时，标记为 `sensitive` 的动作会先问用户；没有确认通道时是拒绝，
  不是放行。
- `/dsh-live-browser` 路由拒绝跨站与非回环的调用方。本机进程仍能伪造这些头，但它本来就能
  读写和你一样的文件。

## 测试

```bash
node test/test-all.mjs
```

十二个套件，分两类：

- **不需要浏览器** —— 包完整性、工具契约、工具层、桥接、端到端链路、客户端驱动、
  会话绑定、设置项、DOM 行为。任何环境都能跑，`npm test` 即可。
- **需要真实页面** —— 场景、注入脚本、图表导出。它们通过 `test/fixtures/` 里的 CDP
  夹具驱动真实页面，这个夹具**只为测试而存在**；实际发的插件从不直接碰 Chrome。
  用 `node scripts/ensure-browser.mjs` 起一个，或者让它们报 `SKIP`。

「DOM 行为」和「端到端链路」原本也要真浏览器，现在改成在 jsdom 里跑同一份注入脚本，
所以不需要 Chrome。图表导出没跟着改，因为 jsdom 的 canvas 要额外装原生包 `canvas`，
为了跑测试把编译依赖架到使用者机器上不划算。

`test/test-rpc-http.mjs` 需要一个正在运行的 DSH：

```bash
node test/test-rpc-http.mjs "http://127.0.0.1:PORT/?token=..."
```

测试浏览器的路径可以用 `DSH_TEST_CDP_PORT`、`DSH_TEST_PROFILE_DIR`、
`DSH_TEST_DOWNLOAD_DIR` 覆盖。

> 本地改源码后，**必须重启 DSH**：宿主插件的工具注册只在进程启动时发生，文件变化
> 不会热生效。重启前 `browser_*` 工具和 `/dsh-live-browser` 路由都不存在（路由返回
> HTTP 405 就是没加载的信号）。

### 文件不能带 BOM

`package.json` 这类文件如果开头混进 UTF-8 BOM，DSH 会报

```
installation rejected: Cannot validate installed package dsh-live-browser:
SyntaxError: Unexpected token ... is not valid JSON
```

然后把 `package.json`、`pnpm-lock.yaml` 和 `node_modules` **整体回滚**——插件装不上，
但代码本身毫无问题，现象是「工具和路由都不存在」，极难排查。

Windows 上用 PowerShell 的 `Set-Content`、`Out-File` 写文件很容易带上 BOM。仓库里带了
巡检脚本：

```bash
npm run strip-bom     # 扫掉全仓库文本文件的 BOM
```

`test/test-package-integrity.mjs` 也会检查这一点，并核对 `files` 里声明的每个文件是否
真实存在、`exports` 指向的入口是否存在、运行时代码有没有 `console.log` 残留。

### 在内置浏览器里实测

凡是依赖真实渲染的行为，都在 DSH 侧边栏的内置浏览器里跑过一遍。做法是先
`node scripts/verify-in-browser.mjs --serve` 起本地页面，再用 `browser_*` 工具驱动。

结论（实测通过）：

- **pointer 事件** —— 一次点击产生的序列是
  `pointerover, pointerenter, pointerdown, mousedown, pointerup, mouseup, click`，
  且每个事件恰好一次。只监听 `pointerdown` 的库（拖拽类、React 合成事件）也能收到。
- **编辑键** —— Backspace 删一个字符、Shift+A 输入大写 A（不是 `+A`）、
  Control+a 清空、Enter 在 textarea 里插入换行。
- **contenteditable** —— `browser_type` 能写入，编辑键也能作用在可编辑 div 上。
- **ref 生命周期** —— 连续多次 `browser_snapshot`，ref 数量稳定，不随快照次数增长。
- **链接跳转** —— 点击 `<a>` 会真实导航，落点页面的标题与正文都变了。

这几个行为里有三个曾经是真 bug：pointer 事件根本没派发、编辑键只发 keydown
不改值、修饰键被模板字符串的反斜杠吞掉导致 `Control+a` 解析成 `+a`。

## 发布

插件可以直接从 GitHub 或 npm 安装，不需要任何注册步骤。如果要被那些索引 GitHub 的社区
插件市场收录，仓库带上 `dsh-plugin` topic 即可，它们会按自己的节奏重新扫描。

## 许可

MIT
