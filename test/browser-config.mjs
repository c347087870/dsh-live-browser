/**
 * Where the test harness keeps its browser.
 *
 * The four suites that drive a real page share one Chrome profile, so they need
 * the same paths. They used to repeat an absolute `C:/Users/<name>/...` path in
 * each file, which made the repository unusable on any other machine.
 *
 * Every value can be overridden by environment variable:
 *
 *   DSH_TEST_CDP_PORT    remote debugging port (default 9333)
 *   DSH_TEST_PROFILE_DIR directory for the throwaway Chrome profile
 *   DSH_TEST_DOWNLOAD_DIR directory downloads are checked in
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

const storageRoot = join(homedir(), '.dsh', 'storages', 'dsh-live-browser')

/**
 * Paths use forward slashes because Chrome's command line takes them on every
 * platform and the launcher passes them straight through.
 */
const toSlashes = (path) => path.replace(/\\/g, '/')

/** Shared configuration for every suite that needs a live page. */
export const testBrowserConfig = {
  debugPort: Number(process.env.DSH_TEST_CDP_PORT) > 0 ? Number(process.env.DSH_TEST_CDP_PORT) : 9333,
  userDataDir: toSlashes(process.env.DSH_TEST_PROFILE_DIR ?? join(storageRoot, 'chrome-profile')),
  downloadDir: toSlashes(process.env.DSH_TEST_DOWNLOAD_DIR ?? join(storageRoot, 'downloads')),
}
