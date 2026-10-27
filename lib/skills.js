/**
 * Registers the `dsh-live-browser` skill, which tells the model how to work the
 * embedded browser well: snapshot first, act by ref, read text for content,
 * confirm before anything irreversible.
 *
 * A skill is advisory text, so it is registered lazily — profiles without a
 * skill registry still get every tool.
 */

const NAME = 'dsh-live-browser'

const DESCRIPTION =
  '在 DSH 侧边栏的内嵌浏览器里完成网页任务：打开页面、读取内容、点击输入、截图，敏感操作先确认'

const BODY = `# 用内嵌浏览器完成任务

页面就渲染在 DSH 右侧栏的「浏览器」标签页里，用户能同时看到你的每一步操作。

## 基本流程

1. \`browser_navigate\` 打开目标地址。
2. \`browser_snapshot\` 拿到可交互元素的 \`ref\`，这是后续操作的定位依据。
3. 用 \`ref\` 调 \`browser_click\` / \`browser_type\` / \`browser_select\`。
4. 需要读正文时用 \`browser_read_text\`，比解析快照更省 token。
5. 等待页面变化用 \`browser_wait\`（等选择器或等文本），不要盲等。

## 关键约定

- **ref 会失效**：页面导航或重新渲染后 ref 全部作废，重新 \`browser_snapshot\`。
- **优先 ref，其次 selector**：ref 来自真实渲染结果，比手写选择器可靠。
- **敏感操作先问**：下单、付款、删除、发送消息、修改账号等不可撤销的动作，把 \`sensitive\` 设为 \`true\`，插件会请用户确认；用户拒绝时返回 \`executed:false\`，不要重试。
- **登录由用户完成**：遇到扫码、短信验证码，让用户直接在面板里操作，你继续等待页面变化即可。
- **面板没开时**：\`browser_status\` 会告诉你 \`attached:false\`，可调 \`browser_open_panel\`，或请用户点右侧栏的「浏览器」标签页。

## 常见任务写法

- 填表单：\`browser_snapshot\` → 逐个 \`browser_type\` → \`browser_click\` 提交。
- 读列表：\`browser_read_text\` 加 \`selector\` 限定范围，再按需 \`browser_eval\` 取结构化数据。
- 翻页：\`browser_click\` 下一页按钮后 \`browser_wait\` 等新内容出现。
`

/**
 * Register the skill when the profile has a skill registry.
 *
 * @param {object} ctx plugin context
 */
export function registerSkills(ctx) {
  let registry
  try {
    registry = ctx.get('skills')
  } catch {
    registry = undefined
  }
  if (registry === undefined || typeof registry.register !== 'function') return

  ctx.effect(
    () => registry.register({ name: NAME, description: DESCRIPTION, content: BODY }),
    'dsh-live-browser: skill',
  )
}
