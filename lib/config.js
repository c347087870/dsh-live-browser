/**
 * Resolved plugin configuration.
 *
 * Dependency-free on purpose: the tool layer, the RPC layer and the tests all
 * read config values, and none of them should need a `node_modules` tree to do
 * it. The schemastery form lives in `schema.js`, which only the entry point
 * imports.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Hard ceilings. A config value may widen a limit up to these but never past
 * them: these are the sizes at which the page, the bridge or the host stop
 * being able to answer at all.
 */
export const CEILINGS = {
  maxSnapshotNodes: 5000,
  maxTextChars: 200_000,
  waitTimeoutMs: 300_000,
  commandTimeoutMs: 300_000,
  uploadMaxBytes: 64 * 1024 * 1024,
}

/** Where screenshots land when no directory is configured. */
export const defaultImageDir = () => join(homedir(), '.dsh', 'storages', 'dsh-live-browser', 'images')

/** Where downloads land when no directory is configured (Electron's default). */
export const defaultDownloadsDir = () => join(homedir(), 'Downloads')

/**
 * Clamp a numeric config value into `[min, max]`, falling back when it is not a
 * usable number. A bad setting must never turn into a thrown error at tool
 * time: the user would see a broken tool instead of a wrong default.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
export function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.round(number), min), max)
}

/** A configured directory, or the default when the setting is blank. */
function directoryOr(value, fallback) {
  const text = String(value ?? '').trim()
  return text === '' ? fallback : text
}

/**
 * Resolve the raw patch config into the shape the rest of the plugin uses.
 *
 * Every field has a working default, so an empty object (a fresh profile, or a
 * test) behaves exactly like the documented defaults.
 *
 * @param {object} [raw] whatever the loader passed as plugin config
 */
export function resolveConfig(raw = {}) {
  const config = raw ?? {}
  return {
    /* --- safety ------------------------------------------------------- */
    confirmSensitive: config.confirmSensitive !== false,
    allowEval: config.allowEval !== false,

    /* --- limits ------------------------------------------------------- */
    commandTimeoutMs: clampNumber(config.commandTimeoutMs, 30_000, 1_000, CEILINGS.commandTimeoutMs),
    openPanelWaitMs: clampNumber(config.openPanelWaitMs, 8_000, 500, 60_000),
    maxSnapshotNodes: clampNumber(config.maxSnapshotNodes, 400, 1, CEILINGS.maxSnapshotNodes),
    maxTextChars: clampNumber(config.maxTextChars, 12_000, 1, CEILINGS.maxTextChars),
    waitTimeoutMs: clampNumber(config.waitTimeoutMs, 10_000, 50, CEILINGS.waitTimeoutMs),
    uploadMaxBytes: clampNumber(config.uploadMaxBytes, 16 * 1024 * 1024, 1, CEILINGS.uploadMaxBytes),

    /* --- paths -------------------------------------------------------- */
    imageDir: directoryOr(config.imageDir, defaultImageDir()),
    downloadsDir: directoryOr(config.downloadsDir, defaultDownloadsDir()),

    /* --- behaviour ---------------------------------------------------- */
    autoOpenPanel: config.autoOpenPanel !== false,
  }
}
