/**
 * Plugin configuration.
 *
 * Two halves, deliberately in two files:
 *
 *   - `config-values.js` resolves the raw patch config into the shape every
 *     module reads. It has no dependencies, so the tool layer and the tests can
 *     import it without a `node_modules` tree.
 *   - this file declares the form DSH renders, which needs `schemastery`.
 *
 * Only the plugin entry point imports this module, so a profile that merely
 * loads the tools never has to resolve `schemastery`.
 */

import Schema from 'schemastery'

/** The form DSH renders on the plugin's settings card. */
export const Config = Schema.object({
  confirmSensitive: Schema.boolean()
    .default(true)
    .description('敏感操作（下单/付款/删除/发送消息等）执行前是否先向用户确认。关闭后，标记 sensitive 的操作将直接执行。'),
  allowEval: Schema.boolean()
    .default(true)
    .description('允许 browser_eval 在页面里执行任意 JavaScript。关闭后该工具返回「已禁用」，其余工具不受影响。'),
  autoOpenPanel: Schema.boolean()
    .default(true)
    .description('命令到达时若右侧栏还没有页面，是否自动打开浏览器标签页。'),
  commandTimeoutMs: Schema.natural()
    .default(30_000)
    .description('单次浏览器操作等待面板执行的超时时间（毫秒）。'),
  openPanelWaitMs: Schema.natural()
    .default(8_000)
    .description('打开面板后等待页面就绪的时间（毫秒）。'),
  maxSnapshotNodes: Schema.natural()
    .default(400)
    .description('browser_snapshot 默认返回的节点上限（调用方可以另行指定）。'),
  maxTextChars: Schema.natural()
    .default(12_000)
    .description('browser_read_text 默认返回的字符上限（调用方可以另行指定）。'),
  waitTimeoutMs: Schema.natural()
    .default(10_000)
    .description('browser_wait 的默认超时时间（毫秒）。'),
  uploadMaxBytes: Schema.natural()
    .default(16 * 1024 * 1024)
    .description('browser_upload 单个文件的字节上限，默认 16MB。'),
  imageDir: Schema.string()
    .default('')
    .description('browser_screenshot 的图片保存目录。留空则用 ~/.dsh/storages/dsh-live-browser/images。'),
  downloadsDir: Schema.string()
    .default('')
    .description('browser_downloads 读取的目录。留空则用系统的「下载」文件夹。'),
})
