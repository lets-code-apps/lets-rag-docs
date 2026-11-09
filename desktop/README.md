# Let's RAG Docs — desktop (placeholder)

A minimal Electron shell. It opens **one neutral window** that says "this is a placeholder" and
does nothing else: no backend, no IPC, no preload, no network. The product direction is deliberately
still open (see CLAUDE.md step 9 — browse, ask, upload come later). This is the *foundation*, not the
app.

## Requirements

- **Node 24** and npm. Electron 45.2.3, TypeScript 5.9.3, `@types/node` 24.19.2 (exact pins; see
  `package.json`).
- The desktop needs **no Rust**; the Rust crate build needs **no Node**. They are independent. `desktop/`
  has no `Cargo.toml` and `Cargo.toml` `exclude`s `desktop/`, so `cargo` never sees it (except to keep it
  out of the published crate).

## Commands

Run every command from this `desktop/` directory.

| Step | Command | Meaning |
|---|---|---|
| Setup | `npm ci` | install from `package-lock.json`; downloads the Electron binary once |
| Typecheck | `npm run typecheck` | `tsc -p tsconfig.json --noEmit` (types only, no output) |
| Test | `npm test` | `node --test test/*.test.ts` — runs the pure logic with no GUI |
| Build | `npm run build` | `tsc -p tsconfig.build.json` into `dist/` |
| Dev launch | `npm start` | build, then `electron .` (opens a visible window; needs a display) |
| Smoke | `npm run smoke` | build, then `RAG_DOCS_SMOKE=1 electron .` (hidden window; no display needed) |

## What the checks prove (and don't)

- `npm test` runs two files under `node:test`:
  - `test/window-policy.test.ts` — the window is 800×600, the renderer is sandboxed
    (`contextIsolation` on, `sandbox` on, `nodeIntegration` off, no `preload`); only the app's own
    `file://` index counts as "ours"; navigation is refused and new windows are denied.
  - `test/boundaries.test.ts` — the shell makes **no network call**, spawns **no process**, pulls in
    no HTTP-client/database/TOML library, `Cargo.toml` excludes `desktop/`, nothing references the
    private `docs/`/`data/`/`evals/` paths, and `index.html` is titled, CSP-locked (`default-src 'none'`),
    and free of any `<script>` or remote URL.
- `npm run smoke` boots real Electron with a **hidden** window, loads the local file, and checks
  Electron reports the title `Let's RAG Docs`, then exits 0 (`SMOKE OK`) — or 1 (`SMOKE FAIL`). It proves
  the shell launches and stays on its own file. It does **not** prove pixels or interaction: nothing is
  visible, and there is nothing to click yet.
- `npm start` shows the window for a human to see; it needs a display, so it is a manual check (Piotr
  runs it). It is not part of the automated checks.

## Boundary rules (enforced by the tests)

- No network: no `node:http`/`https`/`net`/`dgram`, no `fetch`, no Electron `net`/`session` fetch. The
  only network use is `npm ci` fetching the Electron binary once at setup.
- No `child_process`: the shell never spawns the `lets-rag-docs` binary (yet).
- No reading the private `docs/`, `data/`, `evals/` directories.
- The renderer is sandboxed and loads only local `file://` content under a CSP of `default-src 'none'`.

## The later seam (not built here)

When the desktop grows features, the backend will be the **`lets-rag-docs` binary over MCP stdio** —
the same server agents use (CLAUDE.md step 9). That wiring (a preload bridge, IPC, spawning the binary)
is deliberately absent today, and its absence is what the boundary tests guard. Never run the desktop
against real documents; only Piotr does that on his own private copy.
