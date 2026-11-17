# Let's RAG Docs — desktop

A macOS menu-bar Electron companion for the `lets-rag-docs` Rust engine. It lives in the menu bar
(click the icon to show or focus the window, right-click for Open/Quit), shows the **ask** and
**filing** screens from the approved RagAsk/RagFiling designs, and calls the engine one-shot over its
command line. It never
reads the repository's local model, database, config file or document folders itself, and it never
points the app at real data: `npm run smoke` and `npm run shots` hard-set `test/fixtures/fake-engine.mjs`.

## Requirements

- Node 24 and npm. Electron 45.2.3, TypeScript 5.9.3, `@types/node` 24.19.2.
- The desktop needs no Rust to run its unit tests. To use the real engine, build it with `cargo build`
  from the repository root, or set `RAG_DOCS_ENGINE_PATH` to a built binary.

## Commands

Run from this `desktop/` directory.

| Step | Command | Meaning |
|---|---|---|
| Setup | `npm ci` | install from `package-lock.json`; downloads the Electron binary once |
| Typecheck | `npm run typecheck` | `tsc -p tsconfig.json --noEmit` (types only, no output) |
| Test | `npm test` | `node --test test/*.test.ts` — pure logic, no GUI, no real engine |
| Build | `npm run build` | `tsc -p tsconfig.build.json` into `dist/` and copy `preload.cjs` |
| Dev launch | `npm start` | build, then open a visible window (`RAG_DOCS_START_WINDOW=1 electron .`) |
| Smoke | `npm run smoke` | build, then hidden Electron with the fake engine; exits `SMOKE OK` / `SMOKE FAIL` |
| Screenshots | `npm run shots` | build, then drive the real page against the fake engine (type, click, save, re-sort) and `capturePage` ask plus the 10 RagFiling states (and the 360px form, scrolled) in light and dark: 24 PNGs under `screenshots/` |
| Icons | `npm run icons` | re-render `assets/*.png` from SVG (see below) |

## Engine contract

The desktop builds argv itself; the renderer only sends data. Expected engine states are exit 0 JSON
data; real failures exit non-zero with empty stdout and a reason on stderr.

| Call | Desktop API | Shape |
|---|---|---|
| `documents --json` | `rag.documents()` | `{version, status, documents:[{path,title,type,date,folder,owner,filed_as}]}` |
| `ask --json -- <question>` | `rag.ask()` | `{version, answer:string|null, sources:[{source,file,chunk,score}]}` |
| `filing show --json` | `rag.filing()` | `{version, folders, owners, shared_owner}` |
| `filing save [--check]` (stdin JSON draft) | `rag.saveFiling()` | `{version, ok, saved, folders, owners, errors}` |
| `organize --dry-run --json` | `rag.dryRun()` | `{version, mode, status, items, counts}` |
| `organize --apply --json` | `rag.resort()` | same shape as dry-run; refused unless the last report was a dry-run with `status:"ok"`, with no save and no apply since |

Time budgets: reads 10 s, dry-run 10 min (it hashes every original), apply 60 min (it copies and
re-embeds a batch through the local model), ask 6 min. A call over budget is stopped and reported as
"… timed out", never parsed as half a report. `ask` and `apply` share one slot (local LLM, concurrency 1).

Binary lookup: `RAG_DOCS_ENGINE_PATH`, then `<resources>/engine/lets-rag-docs`, then
`<repo>/target/debug/lets-rag-docs`. `--config` is added only when `RAG_DOCS_CONFIG` is set.

## Sample data

None. Every value on screen comes from an engine report or from what the user typed; the page has no
demo or sample mode (a test checks). Designed details the engine cannot supply yet are left out and
listed as follow-ups in the PR: page counts and sizes in the library, "not indexed" pills, page numbers
in citations, "open" for a cited document, the AppBar search and "add documents", editing the shared
owner's name, and a rename that also re-files documents (today they go to unsorted until
`lets-rag-docs classify --force`).

## Icons

`npm run icons` (`scripts/make-icons.mjs`) renders the PNGs with Electron's own Chromium, no image
library: `assets/menubarTemplate.png` / `@2x` (18 and 36 px, black on transparent) are drawn like Triage
Mail's `menubar.svg` with the RAG emblem's two text lines; `assets/icon.png` (1024 px) is a grain tile
(radius 23%) with the white emblem from `renderer/emblem.svg` at 64%. macOS tints the template through
`nativeImage.setTemplateImage(true)`; the dock icon is set only when running unpackaged.

## Boundary rules

- No network calls from the app: no Node HTTP/TLS/socket/dgram, no `fetch`, no Electron network/session fetch.
- Only `engine.ts` imports `child_process`; it spawns the engine one-shot.
- No database/TOML/HTTP npm dependencies and no Playwright dependency.
- No references to the private document paths inside the desktop source/renderer.
- The renderer is sandboxed, context-isolated, preload-only, CSP `default-src 'none'`, and never uses
  `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`.
- Smoke/screenshots always use `test/fixtures/fake-engine.mjs` and synthetic fixtures.