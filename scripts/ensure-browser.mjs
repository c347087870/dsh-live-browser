/** Launch the plugin's test browser if it is not already up, so tests can run. */
import { BrowserLauncher } from '../test-fixtures/chrome.js'
import { testBrowserConfig } from '../browser-config.mjs'

const launcher = new BrowserLauncher(testBrowserConfig)
const existing = await launcher.probe()
if (existing !== undefined) {
  console.log('already running:', existing.Browser)
} else {
  const launched = await launcher.launch({ url: 'about:blank' })
  console.log('launched:', launched.version.Browser)
}
