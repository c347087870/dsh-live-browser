# dsh-live-browser

Let the agent drive the browser DSH already ships — inside DSH, with nothing
leaving the window.

[中文](README.md) | English

DSH's own `@deepseek-ai/dsh-client-ui-sidebar-browser` renders a real Electron
`<webview>` in the right sidebar, with an address bar, history and an independent
browser session. It exposes navigation only, so the agent can open a page but
cannot click, type, read or scroll it.

This plugin closes that gap **without modifying DSH**: it finds the guests that
plugin mounted, injects a command surface into each document, and gives the model
25 `browser_*` tools that operate the page the human is looking at.

## Install

Requires DSH 0.2.x and Node.js 20 or newer. The plugin declares its DSH bundle in
`package.json`, so DSH registers it on install.

### From GitHub

```bash
# Web / CLI profile
dsh plugin --profile web install c347087870/dsh-live-browser
```

The desktop profile is owned by the Electron application, so install it from the
UI instead: **Plugins → Add plugin**, paste
`https://github.com/c347087870/dsh-live-browser`, then restart DSH.

### From npm

```bash
dsh plugin --profile web install dsh-live-browser
```

### Verify the install

```bash
node -e "const p=require('./node_modules/dsh-live-browser/package.json');console.log(p.version, p.dsh)"
```

`dsh.bundle.patch` must be present, and `lib/index.js` must exist. After a
restart the plugin logs
`[dsh-live-browser] loaded: 25 tools, driving the DSH sidebar browser`.

> A junction (`mklink /J`, `ln -s`) does **not** work for local development: Node
> resolves the real path, so `schemastery` is looked up where the source lives
> rather than in the profile. Copy the package directory, or install it with
> `dsh plugin`.

## Settings

DSH renders these on the plugin's settings card. Every one has a default, so the
plugin works without touching any of them.

| Setting | Default | Meaning |
|---|---|---|
| `confirmSensitive` | `true` | Ask the user before an action marked `sensitive` |
| `allowEval` | `true` | Allow `browser_eval` to run arbitrary JavaScript in the page |
| `autoOpenPanel` | `true` | Open the sidebar browser when a command arrives with no page |
| `commandTimeoutMs` | `30000` | How long one command may wait for the panel |
| `openPanelWaitMs` | `8000` | How long to wait for a new panel to become ready |
| `maxSnapshotNodes` | `400` | Default node cap for `browser_snapshot` |
| `maxTextChars` | `12000` | Default character cap for `browser_read_text` |
| `waitTimeoutMs` | `10000` | Default timeout for `browser_wait` |
| `uploadMaxBytes` | `16777216` | Largest file `browser_upload` will hand to a page |
| `imageDir` | empty | Where `browser_screenshot` writes PNGs; empty uses `~/.dsh/storages/dsh-live-browser/images` |
| `downloadsDir` | empty | Directory `browser_downloads` lists; empty uses the system Downloads folder |

`allowEval: false` is the switch to reach for if you want the agent to read pages
without running code in them. `browser_eval` then returns `executed: false` and
points at `browser_snapshot` / `browser_read_text` instead.

## Opening the browser

The agent never asks you to open a browser first, and it never reaches for an
external window:

- Tools queue a command on the host, tagged with the **conversation** that asked.
- The plugin's client bundle polls continuously, even when no browser tab exists.
- If a command arrives with no page on screen, the client opens the **DSH sidebar
  browser** itself (the same `openTabIn(sessionId, 'browser', …)` call the sidebar
  uses internally), waits for the guest to mount, then runs the command.

So `browser_navigate` on a cold start shows up as a sidebar tab that opens by
itself and loads the requested page.

### One browser per conversation

DSH keeps a separate sidebar per Session, and this plugin respects that:

- Every command carries the Session id of the chat that issued it
  (`exec.agent.session.id` on the host).
- A panel only receives commands belonging to its own Session, so a second chat's
  sidebar polling at the same time cannot steal them.
- When the browser has to be opened, it opens in the **requesting** chat via
  `openTabIn(sessionId, …)`, not in whichever chat happens to be on screen.

That is what stops the old failure mode: ask for a page in chat A, switch to chat
B before it opens, and find the browser in B.

> Why the renderer does the opening: the sidebar lives entirely in the client —
> its host module contributes nothing — so there is no host service to call. The
> client half publishes `sidebarRight` through `ctx.reflect.provide`, which is
> what this plugin uses.

## Why this shape

| | This plugin | Patching the shipped bundle |
|---|---|---|
| Click / type / read / scroll | yes | yes |
| Export a page's charts as PNG | yes, via the page's own canvas/SVG | yes |
| Native window screenshots | no | yes |
| Survives a DSH upgrade | yes | no — re-patch every release |
| Risk to existing features | none | can break sidebar link handling |

## How it works

```
agent tool call
      │  bridge.call(method, params)          lib/bridge.js
      ▼
  command queue  ──────►  panel long-polls   client.js
                                │
                                ├─ no guest yet → open the sidebar browser
                                ├─ page commands  → injected script in the guest
                                ├─ browser commands → guest element (loadURL/goBack…)
                                └─ tab commands   → sidebar service
                                │
                          settle(result)
                                ▼
                        tool result
```

- **`lib/bridge.js`** — the queue and the long poll. Cold calls stay queued long
  enough for the client to open a tab; a call that never gets a panel fails with
  an actionable message instead of hanging.
- **`lib/agent-script.js`** — the script injected into every guest document. Pure
  DOM: snapshot with stable `ref`s, click, type, press, select, hover, scroll,
  read text, evaluate, wait, attach files, capture canvas/SVG to PNG.
- **`lib/rpc.js`** — one prefix route on the DSH web server (`/dsh-live-browser`)
  speaking the panel's small request/response envelope. Every request is checked
  for a same-origin browser and loopback host, because the route can write files
  (`saveImage`) and read them (`readUpload`).
- **`lib/config.js` / `lib/schema.js`** — the settings values and the form DSH
  renders. Values are dependency-free so the tool layer and tests can read them
  without a `node_modules` tree.
- **`client.js`** — finds `webview[data-sidebar-browser-frame="webview"]`, injects
  the script, opens the tab when needed, and runs the poll loop. IIFE-wrapped:
  DSH batches plugin bundles into one combo `<script>`, so a top-level `const`
  would collide with a sibling.

### Why not `connection.rpc.handle`

On dsh 0.2.1-rc.2 that API builds its route with
`owner.effect(() => owner.webServer.register(route))`, where `owner` is the
connection plugin's own context — which never declared a `webServer` dependency.
The property read throws `cannot get property "webServer" without inject`, the
effect swallows it, and every panel request falls through to the static frontend
fallback as **HTTP 405**. Registering on `webServer` directly is the same call
without the broken indirection.

## Tools

| Tool | Purpose |
|---|---|
| `browser_status` | Is the panel open, what page is showing |
| `browser_open_panel` | Open the sidebar browser (also happens automatically) |
| `browser_navigate` / `back` / `forward` / `reload` | Navigation |
| `browser_snapshot` | Accessibility-style node list with stable `ref`s |
| `browser_read_text` | Visible body text, optionally scoped by selector |
| `browser_click` / `type` / `press` / `select` / `hover` | Page interaction |
| `browser_scroll` / `wait` | Scrolling and waiting |
| `browser_eval` | Run a JS expression in the page |
| `browser_screenshot` | Export a chart (canvas/SVG) or element as a PNG file |
| `browser_tabs` / `tab_new` | List tabs, open a new browser tab |
| `browser_upload` | Attach local files to a file input |
| `browser_downloads` | List files in the downloads folder |
| `browser_confirm` | Ask the human to confirm an irreversible action |

### Tabs

The sidebar keeps its tab ids internal. The plugin acts on the focused guest, or
the newest one when nothing is focused, and there is no `tab` argument to aim it
elsewhere: the parameter used to exist and was silently dropped, which let a
caller believe it had targeted a specific tab. `browser_tabs` still lists what is
open.

### Honest limits

Three things DSH does not let a plugin do, reported as structured results rather
than silent failures:

- **`browser_tab_close` / `browser_tab_activate`** — the sidebar keeps tab ids
  internal; the tool tells you to click the tab yourself.
- **`browser_reset_profile`** — the browser session is not exposed for clearing;
  the tool returns step-by-step instructions.
- **Native window screenshots** — the guest renders natively, so there are no
  pixels at the DOM level. `browser_screenshot` instead asks the page to
  rasterise its own `<canvas>`/`<svg>`, which is exactly what charts are.

## Security

- The plugin never patches DSH. It reads the DOM the official sidebar browser
  renders and injects a script into guests the official plugin mounted.
- `browser_eval` runs arbitrary JavaScript in whatever page is loaded. That is the
  point of the tool and the reason `allowEval` exists.
- Actions marked `sensitive` ask the user first while `confirmSensitive` is on.
  A missing question channel denies rather than allows.
- The `/dsh-live-browser` route refuses cross-site and non-loopback callers. A
  local process could still spoof the headers, but it can already read and write
  the same files as you.

## Tests

```bash
node test/test-all.mjs
```

Ten suites. Two groups:

- **No browser needed** — tool contracts, the bridge, the client driver, session
  binding, the tool layer. These run anywhere.
- **Need a live page** — scenarios, the injected script, chart capture, the
  end-to-end path. They drive a real page through the CDP harness in
  `test/fixtures/`, which exists **only** for testing; the shipped plugin never
  touches Chrome directly. Start one with `node scripts/ensure-browser.mjs`, or
  let them report `SKIP`.

`test/test-rpc-http.mjs` needs a running DSH:

```bash
node test/test-rpc-http.mjs "http://127.0.0.1:PORT/?token=..."
```

Paths for the test browser can be overridden with `DSH_TEST_CDP_PORT`,
`DSH_TEST_PROFILE_DIR` and `DSH_TEST_DOWNLOAD_DIR`.

> After editing the source locally, **DSH must be restarted**: host plugin tool
> registration happens only at process start, so file changes do not take effect.
> Until the restart, the `browser_*` tools and the `/dsh-live-browser` route do not
> exist (an HTTP 405 from that route is the signal that it is not loaded).

## Publish

The plugin is installable straight from GitHub or npm with no registry step. To
have it listed in the community plugin markets that index GitHub, the repository
carries the `dsh-plugin` topic; those indexes rescan on their own schedule.

## License

MIT
