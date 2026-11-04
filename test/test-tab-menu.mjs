/**
 * Right-click tab menu: 鍏抽棴鍏朵粬 / 鍏抽棴鍏ㄩ儴 / 鍏抽棴鍙充晶.
 *
 * The menu entries live in the shipped sidebar's list slot, so the only thing
 * this suite can prove without a browser is the part that decides *which* tabs
 * each entry closes, plus how those ids reach the controller. The strip is read
 * from the DOM because that is the only place the visual tab order exists.
 */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

const failures = []
const check = (label, condition, detail) => {
  if (condition) console.log(`PASS ${label}`)
  else { failures.push(label); console.log(`FAIL ${label}${detail === undefined ? '' : ` 鈥?${detail}`}`) }
}

/** Load client.js as Node does: the module.exports branch, no window. */
const load = () => {
  const sandbox = { module: { exports: {} } }
  runInContext(source, createContext(sandbox))
  return sandbox.module.exports
}

const { tabStripIds, closingPlan, closeTabs, decorateTabMenu } = load()

const page = (html) => new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document

console.log('\n--- the strip is read in visual order ---------------------------')

{
  const document = page(`
    <div data-dockkit-strip-tabs="pane-1">
      <div data-dockkit-tab="t1"></div>
      <div data-dockkit-tab="t2"></div>
      <div data-dockkit-tab="t3"></div>
      <div data-dockkit-tab="t4"></div>
    </div>`)
  const ids = tabStripIds(document, 't2')
  check('ids come back in strip order', JSON.stringify(ids) === JSON.stringify(['t1', 't2', 't3', 't4']), JSON.stringify(ids))
  check('a tab outside a strip reports nothing', tabStripIds(document, 'nope').length === 0)
}

console.log('\n--- each entry closes the right set ------------------------------')

{
  const ids = ['t1', 't2', 't3', 't4']
  const plan = closingPlan(ids, 't2')
  check('close others keeps every tab but this one', JSON.stringify(plan.others) === JSON.stringify(['t1', 't3', 't4']), JSON.stringify(plan.others))
  check('close all keeps the whole strip', JSON.stringify(plan.all) === JSON.stringify(ids), JSON.stringify(plan.all))
  check('close right takes only the tabs after this one', JSON.stringify(plan.right) === JSON.stringify(['t3', 't4']), JSON.stringify(plan.right))

  const last = closingPlan(ids, 't4')
  check('on the last tab there is nothing to the right', last.right.length === 0, JSON.stringify(last.right))
  const only = closingPlan(['t1'], 't1')
  check('a lone tab has nothing else and nothing right', only.others.length === 0 && only.right.length === 0)
}

console.log('\n--- a second strip is not mixed in ------------------------------')

{
  const document = page(`
    <div data-dockkit-strip-tabs="pane-1">
      <div data-dockkit-tab="a1"></div><div data-dockkit-tab="a2"></div>
    </div>
    <div data-dockkit-strip-tabs="pane-2">
      <div data-dockkit-tab="b1"></div><div data-dockkit-tab="b2"></div>
    </div>`)
  check('each tab reads its own pane', JSON.stringify(tabStripIds(document, 'b1')) === JSON.stringify(['b1', 'b2']), JSON.stringify(tabStripIds(document, 'b1')))
  check('the other strip is untouched', JSON.stringify(tabStripIds(document, 'a2')) === JSON.stringify(['a1', 'a2']))
}

console.log('\n--- odd tab ids stay selectable --------------------------------')

{
  const document = page('<div data-dockkit-strip-tabs="p"><div data-dockkit-tab=\'t"1\'></div><div data-dockkit-tab="t2"></div></div>')
  const ids = tabStripIds(document, 't"1')
  check('a quote in the id does not break the selector', JSON.stringify(ids) === JSON.stringify(['t"1', 't2']), JSON.stringify(ids))
}

console.log('\n--- closing goes through the sidebar controller -----------------')

{
  const closed = []
  let dismissed = 0
  const ctx = {
    get: (name) => (name === 'sidebarRight' ? { close: (id) => closed.push(id) } : undefined),
  }
  closeTabs(ctx, ['t1', 't3'], () => { dismissed += 1 })
  check('every id is closed', JSON.stringify(closed) === JSON.stringify(['t1', 't3']), JSON.stringify(closed))
  check('the menu is dismissed once', dismissed === 1, String(dismissed))
}

console.log('\n--- one failing close does not stop the rest -------------------')

{
  const closed = []
  const ctx = {
    get: (name) =>
      name === 'sidebarRight'
        ? { close: (id) => { if (id === 'boom') throw new Error('gone'); closed.push(id) } }
        : undefined,
  }
  closeTabs(ctx, ['boom', 't2'], () => {})
  check('the surviving tab is still closed', JSON.stringify(closed) === JSON.stringify(['t2']), JSON.stringify(closed))
}

console.log('\n--- no controller, no crash -------------------------------------')

{
  let threw = false
  try {
    closeTabs({ get: () => undefined }, ['t1'], () => {})
  } catch {
    threw = true
  }
  check('a build without sidebarRight is a no-op', threw === false)
}


// ---------------------------------------------------------------------------
// Through the real menu DOM: the entries are appended to the open menu
// ---------------------------------------------------------------------------

const menuPage = (ids) => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div data-dockkit-strip-tabs="pane-1">
      ${ids.map((id) => `<div data-dockkit-tab="${id}"></div>`).join('')}
    </div>
    <div data-dockkit-tab-menu role="menu"><button type="button" data-dockkit-menu-close>关闭</button></div>
  </body></html>`)
  const document = dom.window.document
  return { document, menu: document.querySelector('[data-dockkit-tab-menu]') }
}

const menuButtons = (menu) => [...menu.querySelectorAll('.dsh-live-browser-menu-item')]

console.log('\n--- the open menu gains three entries ---------------------------')

{
  const { menu } = menuPage(['t1', 't2', 't3'])
  const closed = []
  const ctx = { get: (name) => (name === 'sidebarRight' ? { close: (id) => closed.push(id) } : undefined) }
  decorateTabMenu(ctx, menu, 't2')

  const buttons = menuButtons(menu)
  check('three entries are appended', buttons.length === 3, String(buttons.length))
  check('labels match the request', JSON.stringify(buttons.map((button) => button.textContent)) === JSON.stringify(['关闭其他标签页', '关闭全部标签页', '关闭右侧所有标签页']), JSON.stringify(buttons.map((button) => button.textContent)))
  check(
    'they follow the native close item',
    menu.firstElementChild?.hasAttribute('data-dockkit-menu-close') === true &&
      buttons[2].closest('[data-dsh-live-browser-menu]') === menu.lastElementChild,
  )

  buttons[0].click()
  check('close others closes t1 and t3', JSON.stringify(closed) === JSON.stringify(['t1', 't3']), JSON.stringify(closed))

  decorateTabMenu(ctx, menu, 't2')
  check('decorating twice keeps one group', menuButtons(menu).length === 3, String(menuButtons(menu).length))
}

console.log('\n--- the last tab disables "to the right" -----------------------')

{
  const { menu } = menuPage(['t1', 't2'])
  decorateTabMenu({ get: () => undefined }, menu, 't2')
  const buttons = menuButtons(menu)
  check('close right is disabled on the last tab', buttons[2].disabled === true)
  check('the other entries stay enabled', buttons[0].disabled === false && buttons[1].disabled === false)
}

console.log('\n--- a menu without a strip stays inert -------------------------')

{
  const dom = new JSDOM('<!doctype html><html><body><div data-dockkit-tab-menu role="menu"></div></body></html>')
  const menu = dom.window.document.querySelector('[data-dockkit-tab-menu]')
  decorateTabMenu({ get: () => undefined }, menu, 'ghost')
  const buttons = menuButtons(menu)
  check('all three entries are disabled', buttons.every((button) => button.disabled === true), JSON.stringify(buttons.map((button) => button.disabled)))
}

console.log(failures.length === 0 ? '\nTAB MENU OK' : `\nTAB MENU FAILED (${failures.length})`)
process.exit(failures.length === 0 ? 0 : 1)

